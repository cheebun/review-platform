/** Shared wiring for the Slack use-case tests: the review harness plus Slack fakes. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SlackCrypto } from "../../domain/slack/signature";
import type { SecretKind, SettingsStore } from "../../ports/settings-store";
import { InMemoryEventDedupe } from "../../testing/fakes/in-memory-event-dedupe";
import { InMemoryRateLimiter } from "../../testing/fakes/in-memory-rate-limiter";
import { InMemorySettingsStore } from "../../testing/fakes/in-memory-settings-store";
import { InMemoryWakeUp } from "../../testing/fakes/in-memory-wake-up";
import { drainReactionOutbox } from "../review/reaction-drain";
import { harness, T0 } from "../review/harness.test-support";
import { processNextReviewJob } from "../review/review-job-consumer";
import { REVIEW_JOB_WAKE_CHANNEL } from "../review/ports";
import type { ShipDeps } from "../ship/ship";
import { SIGNING_SECRET, USER_TOKEN } from "../settings/slack-testing";
import { SlackCredentials } from "./credentials";
import { receiveSlackEvent, type SlackIngestDeps } from "./ingest";

// Fake Slack ids, never real ones.
export const OWNER = "U0OWNER";
export const TEAM = "T0ACME";
export const OTHER = "U0BOB";

/** HMAC-SHA256 and a constant-time compare, as the node adapter does. */
export const testSlackCrypto: SlackCrypto = {
  hmacSha256Hex: (secret, data) => createHmac("sha256", secret).update(data).digest("hex"),
  timingSafeEqual: (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  },
};

export function signRequest(secret: string, rawBody: string, at: Date) {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = `v0=${testSlackCrypto.hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;
  return { rawBody, timestamp, signature };
}

export async function saveSecret(
  store: SettingsStore,
  kind: SecretKind,
  value: string,
  extra: { verifiedAt?: Date | null; testResult?: Record<string, string> | null } = {},
) {
  await store.saveSecret(
    kind,
    {
      value,
      savedAt: T0,
      savedByUserId: "user-1",
      verifiedAt: extra.verifiedAt ?? null,
      testResult: extra.testResult ?? null,
    },
    () => ({
      id: `evt-${kind}-${value.slice(-4)}`,
      type: "slack_secret_saved",
      actor: { kind: "user", id: "user-1" },
      at: T0,
      source: "web",
    }),
  );
}

/** A Slack ts at `at` (seconds) with a 6-digit suffix. */
export const tsAt = (at: Date, micros = 100) =>
  `${Math.floor(at.getTime() / 1000)}.${String(micros).padStart(6, "0")}`;

/** 2026-11-04 10:00 UTC+8: inside the active hours. */
export const ROOT_TS = tsAt(T0, 100);

let eventSeq = 0;

export type MessageInput = {
  text: string;
  user?: string;
  ts?: string;
  threadTs?: string;
  channel?: string;
  channelType?: string;
  eventId?: string;
  teamId?: string;
  subtype?: string;
};

/** An `event_callback` envelope for one message, authorised for the owner. */
export function messageEnvelope(m: MessageInput) {
  eventSeq += 1;
  return {
    type: "event_callback",
    team_id: m.teamId ?? TEAM,
    api_app_id: "A0APP",
    event_id: m.eventId ?? `Ev0TEST${eventSeq}`,
    event_time: 1793757600,
    authorizations: [{ team_id: TEAM, user_id: OWNER, is_bot: false }],
    event: {
      type: "message",
      ...(m.subtype ? { subtype: m.subtype } : {}),
      user: m.user ?? "U0ALICE",
      text: m.text,
      ts: m.ts ?? ROOT_TS,
      ...(m.threadTs ? { thread_ts: m.threadTs } : {}),
      channel: m.channel ?? "C0REVIEW",
      channel_type: m.channelType ?? "channel",
    },
  };
}

export const mention = (text: string) => `<@${OWNER}> ${text}`;

/** The review harness plus a configured Slack: owner identity, signing secret, fakes. */
export async function slackHarness() {
  const h = harness();
  const settingsStore = new InMemorySettingsStore(h.events);
  await saveSecret(settingsStore, "slack_user_token", USER_TOKEN, {
    verifiedAt: T0,
    testResult: { userId: OWNER, teamId: TEAM, teamName: "Acme", userName: "owner" },
  });
  await saveSecret(settingsStore, "slack_signing_secret", SIGNING_SECRET);
  const credentials = new SlackCredentials({ settingsStore, clock: h.clock });
  const eventDedupe = new InMemoryEventDedupe(h.clock);
  const rateLimiter = new InMemoryRateLimiter(h.clock);
  const wakeUp = new InMemoryWakeUp(h.clock);
  const wakes: string[] = [];
  await wakeUp.subscribe(REVIEW_JOB_WAKE_CHANNEL, () => wakes.push(REVIEW_JOB_WAKE_CHANNEL));
  const review: ShipDeps = {
    github: h.github,
    records: h.records,
    events: h.events,
    jobs: h.jobs,
    threads: h.threads,
    uow: h.uow,
    repoList: () => h.deps.repoList(),
    clock: h.clock,
    ids: h.ids,
    logger: h.logger,
    timers: h.timers,
  };
  const deps: SlackIngestDeps = {
    credentials,
    settingsStore,
    eventDedupe,
    rateLimiter,
    wakeUp,
    replier: h.replier,
    review,
  };

  /** Receives one payload and runs its work to the end, as the route does after the ack. */
  async function deliver(payload: unknown) {
    const received = await receiveSlackEvent(deps, payload);
    if (received.status === "ok" && received.outcome === "accepted") await received.work();
    // Let the in-memory WakeUp deliver.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return received;
  }

  /** Applies every due reaction op with the fake sender. */
  async function drainReactions() {
    for (let i = 0; i < 10; i++) {
      const report = await drainReactionOutbox(
        { outbox: h.outbox, sender: h.sender, timers: h.timers, logger: h.logger },
        "drainer",
      );
      if (report.applied === 0) return;
    }
  }

  const runConsumer = () => processNextReviewJob(h.deps, "worker");
  const reactions = (ts = ROOT_TS) => h.sender.reactions({ channel: "C0REVIEW", ts });
  const replies = () => h.replier.replies.map((r) => r.text);

  return {
    ...h,
    settingsStore,
    credentials,
    eventDedupe,
    rateLimiter,
    wakeUp,
    wakes,
    review,
    ingest: deps,
    deliver,
    drainReactions,
    runConsumer,
    reactions,
    replies,
  };
}
