import { describe, expect, it } from "vitest";
import { PENDING } from "../../domain/slack/status-emoji";
import { T0, PR1, PR2, CHANNEL } from "../review/harness.test-support";
import { messageEnvelope, mention, OWNER, ROOT_TS, slackHarness, tsAt } from "./slack.test-support";
import { receiveSlackEvent } from "./ingest";

const linkMessage = (extra: Parameters<typeof messageEnvelope>[0] | object = {}) =>
  messageEnvelope({ text: mention(`please review ${PR1}`), ...extra });

describe("receiveSlackEvent: envelope", () => {
  it("ignores payloads that are not a valid event_callback, without claiming", async () => {
    const s = await slackHarness();
    for (const payload of [
      null,
      "x",
      { type: "event_callback" },
      { ...linkMessage(), event_id: 1 },
    ]) {
      expect(await receiveSlackEvent(s.ingest, payload)).toMatchObject({
        status: "ok",
        outcome: "ignored",
      });
    }
    expect(await s.jobs.listRecent({ limit: 10 })).toEqual([]);
  });

  it("acks with no work when Slack is not configured", async () => {
    const s = await slackHarness();
    await s.settingsStore.removeSecret("slack_user_token", () => ({
      id: "rm",
      type: "slack_secret_removed",
      actor: { kind: "user", id: "user-1" },
      at: T0,
      source: "web",
    }));
    s.credentials.invalidate();
    expect(await receiveSlackEvent(s.ingest, linkMessage())).toEqual({
      status: "ok",
      outcome: "not_configured",
    });
  });

  it("ignores another workspace", async () => {
    const s = await slackHarness();
    expect(await receiveSlackEvent(s.ingest, linkMessage({ teamId: "T0OTHER" }))).toMatchObject({
      outcome: "ignored",
    });
  });

  it("asks Slack to retry when the dedupe store is down (fail closed)", async () => {
    const s = await slackHarness();
    s.ingest.eventDedupe = {
      claim: async () => {
        throw new Error("redis down");
      },
    };
    expect(await receiveSlackEvent(s.ingest, linkMessage())).toEqual({ status: "retry" });
    expect(s.logger.entries.some((e) => e.level === "error")).toBe(true);
  });

  it("ordinary chat is ignored without claiming the event", async () => {
    const s = await slackHarness();
    let claims = 0;
    s.ingest.eventDedupe = { claim: async () => ((claims += 1), true) };
    await receiveSlackEvent(s.ingest, messageEnvelope({ text: "lunch?" }));
    expect(claims).toBe(0);
  });
});

describe("intake (FR-SLACK-03, FR-SLACK-05)", () => {
  it("a mention with a listed PR link enqueues a job, records the thread, queues ⏳ and replies", async () => {
    const s = await slackHarness();
    const received = await s.deliver(linkMessage());
    expect(received).toMatchObject({ status: "ok", outcome: "accepted" });

    const [job] = await s.jobs.listRecent({ limit: 10 });
    expect(job).toMatchObject({
      source: "slack",
      state: "queued",
      urls: [PR1],
      slack: { channel: CHANNEL, ts: ROOT_TS, user: "U0ALICE" },
    });
    expect(job!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.threads.get({ channel: CHANNEL, threadTs: ROOT_TS })).toMatchObject({
      prUrls: [PR1],
      requesterSlackId: "U0ALICE",
      statusMessageTs: ROOT_TS,
      reviewSeq: 1,
    });
    expect(s.wakes).toEqual(["review-job:wake"]);
    expect(s.replier.replies).toEqual([{ channel: CHANNEL, threadTs: ROOT_TS, text: "on it" }]);
    await s.drainReactions();
    expect(s.reactions()).toEqual([PENDING]);
  });

  it("a duplicate delivery creates nothing new (same event id)", async () => {
    const s = await slackHarness();
    const payload = linkMessage({ eventId: "Ev0DUP" });
    await s.deliver(payload);
    expect(await s.deliver(payload)).toEqual({ status: "ok", outcome: "duplicate" });
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(s.replies()).toEqual(["on it"]);
  });

  it("the same message under another event id is deduplicated by the job id", async () => {
    const s = await slackHarness();
    await s.deliver(linkMessage({ eventId: "Ev0A" }));
    await s.deliver(linkMessage({ eventId: "Ev0B" }));
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(s.replies()).toEqual(["on it"]);
    expect((await s.outbox.listForMessage(CHANNEL, ROOT_TS)).length).toBe(1);
  });

  it("concurrent deliveries on both paths create one job and one reply", async () => {
    const s = await slackHarness();
    const payload = linkMessage({ eventId: "Ev0BOTH" });
    await Promise.all([s.deliver(payload), s.deliver(payload)]);
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(s.replies()).toEqual(["on it"]);
  });

  it("no listed PR link: no job and no reply", async () => {
    const s = await slackHarness();
    await s.deliver(messageEnvelope({ text: mention("see https://github.com/evil/x/pull/1") }));
    await s.deliver(messageEnvelope({ text: mention("no link at all, github.com/") }));
    expect(await s.jobs.listRecent({ limit: 10 })).toEqual([]);
    expect(s.replies()).toEqual([]);
  });

  it("several listed PRs go into one job", async () => {
    const s = await slackHarness();
    await s.deliver(messageEnvelope({ text: mention(`${PR1} and ${PR2}`) }));
    expect((await s.jobs.listRecent({ limit: 10 }))[0]!.urls).toEqual([PR1, PR2]);
  });

  it("respects the review channels; DMs always count", async () => {
    const s = await slackHarness();
    await s.settingsStore.setReviewChannels(
      [{ channelId: "C0ONLY", name: "only", missing: false, checkedAt: null }],
      {
        at: T0,
        by: "user-1",
        event: () => ({
          id: "ch",
          type: "slack_channels_changed",
          actor: { kind: "user", id: "user-1" },
          at: T0,
          source: "web",
        }),
      },
    );
    await s.deliver(linkMessage());
    expect(await s.jobs.listRecent({ limit: 10 })).toEqual([]);
    await s.deliver(linkMessage({ channel: "D0DM", channelType: "im" }));
    await s.deliver(linkMessage({ channel: "C0ONLY", ts: tsAt(T0, 200) }));
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(2);
  });

  it("outside active hours nothing happens", async () => {
    const s = await slackHarness();
    const night = new Date("2026-11-04T12:00:00.000Z"); // 20:00 UTC+8
    await s.deliver(linkMessage({ ts: tsAt(night) }));
    expect(await s.jobs.listRecent({ limit: 10 })).toEqual([]);
    expect(s.replies()).toEqual([]);
  });

  it("a mention inside a thread that already has a review starts nothing", async () => {
    const s = await slackHarness();
    await s.deliver(linkMessage());
    await s.deliver(linkMessage({ ts: tsAt(T0, 300), threadTs: ROOT_TS }));
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
  });

  it("a mention inside a thread with no review starts one on that thread", async () => {
    const s = await slackHarness();
    const ts = tsAt(T0, 300);
    await s.deliver(linkMessage({ ts, threadTs: ROOT_TS }));
    const [job] = await s.jobs.listRecent({ limit: 10 });
    expect(job!.slack).toEqual({ channel: CHANNEL, ts, threadTs: ROOT_TS, user: "U0ALICE" });
    expect(await s.threads.get({ channel: CHANNEL, threadTs: ROOT_TS })).toMatchObject({
      statusMessageTs: ts,
    });
    expect(s.replier.replies[0]).toMatchObject({ threadTs: ROOT_TS });
  });

  it("bot messages and edits never trigger", async () => {
    const s = await slackHarness();
    await s.deliver(linkMessage({ subtype: "message_changed" }));
    await s.deliver(linkMessage({ subtype: "bot_message" }));
    expect(await s.jobs.listRecent({ limit: 10 })).toEqual([]);
  });

  it("a sender over the rate limit gets no job and no reply", async () => {
    const s = await slackHarness();
    s.ingest.config = { senderLimit: { limit: 1, windowMs: 3_600_000 } };
    await s.deliver(linkMessage());
    await s.deliver(linkMessage({ ts: tsAt(T0, 400), text: mention(PR2) }));
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(s.replies()).toEqual(["on it"]);
    expect(s.logger.entries.map((e) => e.msg)).toContain("slack review rate limited");
  });

  it("a failed 'on it' reply is logged and the job stays", async () => {
    const s = await slackHarness();
    s.replier.failNext({ kind: "upstream", service: "slack", retryable: false });
    await s.deliver(linkMessage());
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(s.logger.entries.map((e) => e.msg)).toContain("on it reply failed");
  });

  it("the owner's own replies in a thread are never intake", async () => {
    const s = await slackHarness();
    await s.deliver(linkMessage({ user: OWNER, text: `review result for ${PR1}` }));
    expect(await s.jobs.listRecent({ limit: 10 })).toEqual([]);
  });
});
