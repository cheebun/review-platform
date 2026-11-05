/** What the Slack use cases share: their ports, config and the reply / wake helpers. */
import type { Result } from "../../domain/shared/result";
import { SLACK_REVIEW_ACTIVE_HOURS, type ActiveHours } from "../../domain/slack/review-rules";
import type { EventDedupe } from "../../ports/event-dedupe";
import type { RateLimiter } from "../../ports/rate-limiter";
import type { SettingsStore } from "../../ports/settings-store";
import type { WakeUp } from "../../ports/wake-up";
import type { ThreadReplier } from "../review/ports";
import type { ShipDeps } from "../ship/ship";
import type { SlackCredentials, SlackOwner } from "./credentials";

export type SlackIngestConfig = {
  /** `slack:event:<id>` lifetime: Slack retries for up to a few hours; one day covers both paths. */
  dedupeTtlMs: number;
  /** Per Slack sender, for reviews (S6, assumed values Q11). */
  senderLimit: { limit: number; windowMs: number };
  activeHours: ActiveHours;
  /** How many recent jobs are scanned for a review already in progress. */
  activeJobScan: number;
};

export const DEFAULT_SLACK_INGEST_CONFIG: SlackIngestConfig = {
  dedupeTtlMs: 24 * 60 * 60_000,
  senderLimit: { limit: 20, windowMs: 60 * 60_000 },
  activeHours: SLACK_REVIEW_ACTIVE_HOURS,
  activeJobScan: 100,
};

export type SlackIngestDeps = {
  credentials: SlackCredentials;
  settingsStore: Pick<SettingsStore, "listReviewChannels">;
  eventDedupe: EventDedupe;
  rateLimiter: RateLimiter;
  wakeUp: WakeUp;
  /** Posts as the owner (user token). */
  replier: ThreadReplier;
  /** The review and ship ports (jobs, threads, unit of work, GitHub, repo list, clock, logger). */
  review: ShipDeps;
  config?: Partial<SlackIngestConfig>;
};

export const ingestConfig = (deps: SlackIngestDeps): SlackIngestConfig => ({
  ...DEFAULT_SLACK_INGEST_CONFIG,
  ...deps.config,
});

export type IngestContext = {
  owner: SlackOwner;
  teamId: string;
  eventId: string;
  /** The whole envelope, for the domain trigger matcher. */
  payload: unknown;
};

/** Posts in the thread; a failure is logged, never thrown. */
export async function replyInThread(
  deps: SlackIngestDeps,
  where: { channel: string; threadTs: string },
  text: string,
  failureMessage = "thread reply failed",
): Promise<void> {
  let sent: Result<void>;
  try {
    sent = await deps.replier.reply({ ...where, text });
  } catch {
    sent = { ok: false, error: { kind: "upstream", service: "slack", retryable: true } };
  }
  if (!sent.ok) deps.review.logger.warn(failureMessage, { error: sent.error.kind, ...where });
}

const describe = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** Best effort: a lost wake-up only adds latency, the consumer also polls. */
export async function wakeConsumer(deps: SlackIngestDeps, channel: string): Promise<void> {
  try {
    await deps.wakeUp.notify(channel);
  } catch (error) {
    deps.review.logger.warn("review wake-up not sent", { error: describe(error) });
  }
}
