import { describe, expect, it } from "vitest";
import {
  fakeSecretCiphers,
  InMemorySettingsStore,
} from "../testing/fakes/in-memory-settings-store";
import { SequenceIdGenerator } from "../testing/fakes/sequence-id-generator";
import { PR1, T0 } from "../application/review/harness.test-support";
import { APP_TOKEN, SIGNING_SECRET } from "../application/settings/slack-testing";
import {
  messageEnvelope,
  mention,
  saveSecret,
  signRequest,
  slackHarness,
} from "../application/slack/slack.test-support";
import { nodeSlackCrypto } from "../adapters/slack/node-crypto";
import {
  handleSlackEvents,
  slackFeatureStatus,
  slackReviewPorts,
  type SlackEventServices,
} from "./slack-features";

const EVENTS_URL = "http://localhost/api/slack/events";

async function setup() {
  const s = await slackHarness();
  const services: SlackEventServices = {
    verify: {
      credentials: s.credentials,
      settingsStore: s.settingsStore,
      crypto: nodeSlackCrypto,
      clock: s.clock,
      logger: s.logger,
    },
    ingest: s.ingest,
  };
  const scheduled: Promise<void>[] = [];
  const ctx = {
    services,
    ids: new SequenceIdGenerator(),
    logger: s.logger,
    schedule: (work: () => Promise<void>) => void scheduled.push(work()),
  };
  return { s, services, scheduled, ctx };
}

function signed(body: string, secret = SIGNING_SECRET, at = T0) {
  const { timestamp, signature } = signRequest(secret, body, at);
  return new Request(EVENTS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("POST /api/slack/events", () => {
  it("is 503 slack_events when the Slack ports are not wired", async () => {
    const { ctx } = await setup();
    const res = await handleSlackEvents(signed("{}"), { ...ctx, services: null });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ kind: "not_configured", feature: "slack_events" });
  });

  it("is 503 slack_events without a stored signing secret", async () => {
    const { s, ctx } = await setup();
    await s.settingsStore.removeSecret("slack_signing_secret", () => ({
      id: "rm",
      type: "slack_secret_removed",
      actor: { kind: "user", id: "user-1" },
      at: T0,
      source: "web",
    }));
    s.credentials.invalidate();
    const res = await handleSlackEvents(signed("{}"), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ kind: "not_configured", feature: "slack_events" });
  });

  it("passes needs_reset through", async () => {
    const { s, ctx } = await setup();
    const rotated = s.settingsStore.withCiphers(fakeSecretCiphers(1));
    const { SlackCredentials } = await import("../application/slack/credentials");
    const credentials = new SlackCredentials({ settingsStore: rotated, clock: s.clock });
    const res = await handleSlackEvents(signed("{}"), {
      ...ctx,
      services: { ...ctx.services!, verify: { ...ctx.services!.verify, credentials } },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ feature: "slack_events", reason: "needs_reset" });
  });

  it("rejects a bad signature with 401 and never echoes the body", async () => {
    const { ctx } = await setup();
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const res = await handleSlackEvents(signed(body, "0".repeat(32)), ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("abc");
  });

  it("rejects a stale timestamp with 401", async () => {
    const { ctx } = await setup();
    const res = await handleSlackEvents(
      signed("{}", SIGNING_SECRET, new Date(T0.getTime() - 301_000)),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("answers a signed url_verification with its challenge", async () => {
    const { ctx } = await setup();
    const res = await handleSlackEvents(
      signed(JSON.stringify({ type: "url_verification", token: "x", challenge: "c-123" })),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "c-123" });
  });

  it("acks a signed event at once and processes it afterwards", async () => {
    const { s, ctx, scheduled } = await setup();
    const res = await handleSlackEvents(
      signed(JSON.stringify(messageEnvelope({ text: mention(PR1) }))),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await s.jobs.listRecent({ limit: 5 })).toEqual([]);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(await s.jobs.listRecent({ limit: 5 })).toHaveLength(1);
  });

  it("a signed body that is not JSON is 400", async () => {
    const { ctx } = await setup();
    expect((await handleSlackEvents(signed("not json"), ctx)).status).toBe(400);
  });

  it("an oversized body is 413 before any check", async () => {
    const { ctx } = await setup();
    const res = await handleSlackEvents(signed("x".repeat(1_000_001)), ctx);
    expect(res.status).toBe(413);
  });

  it("is 500 when the dedupe store is down, so Slack retries", async () => {
    const { ctx } = await setup();
    ctx.services.ingest.eventDedupe = {
      claim: async () => {
        throw new Error("redis down at redis://secret-host");
      },
    };
    const res = await handleSlackEvents(
      signed(JSON.stringify(messageEnvelope({ text: mention(PR1) }))),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret-host");
  });
});

describe("slackFeatureStatus: from the settings store, never env", () => {
  it("reports each entry point", async () => {
    const store = new InMemorySettingsStore();
    expect(await slackFeatureStatus(store)).toEqual({
      slack: "not_configured",
      slack_events: "not_configured",
    });
    await saveSecret(store, "slack_app_token", APP_TOKEN);
    await saveSecret(store, "slack_signing_secret", SIGNING_SECRET);
    expect(await slackFeatureStatus(store.withCiphers(fakeSecretCiphers(1)))).toEqual({
      slack: "not_configured",
      slack_events: "needs_reset",
    });
    expect(await slackFeatureStatus(store)).toMatchObject({
      slack_events: "ready",
    });
  });
});

describe("slackReviewPorts", () => {
  it("is null until every review port is wired", () => {
    expect(slackReviewPorts({} as never)).toBeNull();
    const wired = {
      settingsStore: {},
      threadReviews: {},
      reactionOutbox: {},
      reviewRecords: {},
      reviewUnitOfWork: {},
      github: {},
    };
    expect(slackReviewPorts(wired as never)).toBe(wired);
  });
});
