/**
 * HTTP Events API ingestion for `/api/slack/events` (FR-SLACK-02, FR-SLACK-12).
 * Repeated deliveries are classified and deduplicated through the same entry point.
 *
 * `receiveSlackEvent` is the fast part that runs before the ack: validate the untrusted envelope,
 * check the workspace, classify cheaply (intake candidate or thread command) and claim the
 * `event_id` in the shared dedupe store. The slow part is returned as `work`, which the caller
 * runs after acknowledging Slack. A dedupe store that is down fails closed (`retry`).
 */
import { z } from "zod";
import type { Result } from "../../domain/shared/result";
import { parseThreadCommand } from "../../domain/slack/thread-command";
import { SLACK_CHANNEL_ID, SLACK_TS } from "../../ports/thread-review-index";
import { runThreadCommand, type CommandCandidate } from "./commands";
import { ingestConfig, type SlackIngestDeps } from "./context";
import type { SlackOwner } from "./credentials";
import { runIntake } from "./intake";

export type { IngestContext, SlackIngestConfig, SlackIngestDeps } from "./context";
export { DEFAULT_SLACK_INGEST_CONFIG } from "./context";

export type ReceiveOutcome =
  | { status: "ok"; outcome: "ignored"; reason: string }
  | { status: "ok"; outcome: "duplicate" }
  | { status: "ok"; outcome: "not_configured" }
  | { status: "ok"; outcome: "accepted"; work: () => Promise<void> }
  /** Answer non-2xx so Slack redelivers (the store or dedupe is unavailable). */
  | { status: "retry" };

const EVENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TEAM_ID = /^[TE][A-Z0-9]{2,30}$/;
const USER_ID = /^[UWB][A-Z0-9]{2,30}$/;

const Envelope = z.object({
  type: z.literal("event_callback"),
  event_id: z.string().regex(EVENT_ID),
  team_id: z.string().regex(TEAM_ID),
  event: z.record(z.string(), z.unknown()),
});

/** The fields every handled message needs; the domain parsers re-check the rest. */
const MessageEvent = z.object({
  type: z.literal("message"),
  user: z.string().regex(USER_ID),
  text: z.string().max(40_000),
  ts: z.string().regex(SLACK_TS),
  thread_ts: z.string().regex(SLACK_TS).optional(),
  channel: z.string().regex(SLACK_CHANNEL_ID),
});

export type SlackMessageEvent = z.infer<typeof MessageEvent>;

type Classified =
  | { kind: "intake"; event: SlackMessageEvent }
  | { kind: "command"; candidate: CommandCandidate }
  | { kind: "ignored"; reason: string };

const ignored = (reason: string): ReceiveOutcome => ({ status: "ok", outcome: "ignored", reason });

function classify(deps: SlackIngestDeps, owner: SlackOwner, raw: unknown): Classified {
  const event = MessageEvent.safeParse(raw);
  if (!event.success) return { kind: "ignored", reason: "not_handled_message" };
  const parsed = parseThreadCommand(raw, { ownerId: owner.userId });
  if (parsed.kind === "command") {
    return {
      kind: "command",
      candidate: { command: parsed.command, event: event.data, needsRequester: false },
    };
  }
  if (parsed.reason === "not_requester") {
    // `updated`: whether the sender is the requester is known only from the thread (in `work`).
    return {
      kind: "command",
      candidate: { command: "updated", event: event.data, needsRequester: true },
    };
  }
  if (parsed.reason === "not_owner") {
    deps.review.logger.info("thread command ignored", {
      sender: parsed.sender,
      reason: parsed.reason,
      channel: event.data.channel,
    });
    return { kind: "ignored", reason: "not_owner" };
  }
  if (parsed.reason !== "unknown_text" && parsed.reason !== "not_thread") {
    return { kind: "ignored", reason: parsed.reason };
  }
  // Cheap pre-filter; the full trigger rules run in `work` with the repo list and channels.
  const text = event.data.text;
  if (
    event.data.user !== owner.userId &&
    text.includes(`<@${owner.userId}>`) &&
    text.includes("github.com/")
  ) {
    return { kind: "intake", event: event.data };
  }
  return { kind: "ignored", reason: "not_a_request" };
}

const describe = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/**
 * Never throws. `payload` is the parsed HTTP Events API JSON body; it is
 * untrusted and validated here. `url_verification` is answered by the route before this.
 */
export async function receiveSlackEvent(
  deps: SlackIngestDeps,
  payload: unknown,
): Promise<ReceiveOutcome> {
  const log = deps.review.logger;
  const envelope = Envelope.safeParse(payload);
  if (!envelope.success) return ignored("invalid_envelope");
  const { event_id: eventId, team_id: teamId } = envelope.data;

  let owner: Result<SlackOwner>;
  try {
    owner = await deps.credentials.owner();
  } catch (error) {
    log.error("slack owner unavailable", { error: describe(error) });
    return { status: "retry" };
  }
  if (!owner.ok) {
    log.warn("slack event dropped: Slack is not configured", { eventId });
    return { status: "ok", outcome: "not_configured" };
  }
  if (teamId !== owner.value.teamId) return ignored("other_team");

  const classified = classify(deps, owner.value, envelope.data.event);
  if (classified.kind === "ignored") return ignored(classified.reason);

  let claimed: boolean;
  try {
    claimed = await deps.eventDedupe.claim(eventId, ingestConfig(deps).dedupeTtlMs);
  } catch (error) {
    log.error("slack event dedupe unavailable; asking Slack to retry", {
      eventId,
      error: describe(error),
    });
    return { status: "retry" };
  }
  if (!claimed) return { status: "ok", outcome: "duplicate" };

  const ctx = { owner: owner.value, teamId, eventId, payload };
  const work =
    classified.kind === "intake"
      ? () => runIntake(deps, ctx)
      : () => runThreadCommand(deps, ctx, classified.candidate);
  return {
    status: "ok",
    outcome: "accepted",
    work: async () => {
      try {
        await work();
      } catch (error) {
        log.error("slack event processing failed", { eventId, error: describe(error) });
      }
    },
  };
}
