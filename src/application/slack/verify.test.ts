import { describe, expect, it } from "vitest";
import { ok } from "../../domain/shared/result";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { InMemorySettingsStore } from "../../testing/fakes/in-memory-settings-store";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { SIGNING_SECRET, SLACK_NOW } from "../settings/slack-testing";
import { SlackCredentials } from "./credentials";
import { saveSecret, signRequest, testSlackCrypto } from "./slack.test-support";
import { verifySlackRequest } from "./verify";

const BODY = '{"type":"event_callback","event_id":"Ev1"}';
const NEW_SECRET = "f".repeat(32);

async function setup(opts: { saved?: boolean } = {}) {
  const clock = new FakeClock(SLACK_NOW);
  const store = new InMemorySettingsStore();
  if (opts.saved !== false) await saveSecret(store, "slack_signing_secret", SIGNING_SECRET);
  const marks: number[] = [];
  const settingsStore = {
    markSecretVerified: async (_kind: string, version: number, at: Date) => {
      marks.push(version);
      return store.markSecretVerified("slack_signing_secret", version, at);
    },
  };
  const credentials = new SlackCredentials({ settingsStore: store, clock });
  const logger = new MemoryLogger();
  const deps = { credentials, settingsStore, crypto: testSlackCrypto, clock, logger };
  return { clock, store, marks, credentials, deps, logger };
}

describe("verifySlackRequest", () => {
  it("is not configured without a stored signing secret", async () => {
    const { deps } = await setup({ saved: false });
    const r = await verifySlackRequest(deps, signRequest(SIGNING_SECRET, BODY, SLACK_NOW));
    expect(r).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack_events" },
    });
  });

  it("accepts a valid signature on the raw body and marks the secret verified once", async () => {
    const { deps, marks, store } = await setup();
    expect(await verifySlackRequest(deps, signRequest(SIGNING_SECRET, BODY, SLACK_NOW))).toEqual(
      ok(undefined),
    );
    expect(await verifySlackRequest(deps, signRequest(SIGNING_SECRET, BODY, SLACK_NOW))).toEqual(
      ok(undefined),
    );
    expect(marks).toEqual([1]);
    const read = await store.getSecret("slack_signing_secret");
    expect(read.state === "ready" && read.meta.verifiedAt).toEqual(SLACK_NOW);
  });

  it("rejects a body changed after signing", async () => {
    const { deps, marks } = await setup();
    const req = signRequest(SIGNING_SECRET, BODY, SLACK_NOW);
    const r = await verifySlackRequest(deps, { ...req, rawBody: `${BODY} ` });
    expect(r).toEqual({ ok: false, error: { kind: "unauthenticated" } });
    expect(marks).toEqual([]);
  });

  it("rejects a timestamp older than five minutes", async () => {
    const { deps } = await setup();
    const old = new Date(SLACK_NOW.getTime() - 301_000);
    const r = await verifySlackRequest(deps, signRequest(SIGNING_SECRET, BODY, old));
    expect(r).toEqual({ ok: false, error: { kind: "unauthenticated" } });
  });

  it("rejects missing headers", async () => {
    const { deps } = await setup();
    const r = await verifySlackRequest(deps, { rawBody: BODY, timestamp: null, signature: null });
    expect(r).toEqual({ ok: false, error: { kind: "unauthenticated" } });
  });

  it("a secret saved within the cache TTL is picked up on the first mismatch", async () => {
    const { deps, store, credentials } = await setup();
    await credentials.signingSecret();
    await saveSecret(store, "slack_signing_secret", NEW_SECRET);
    expect(await verifySlackRequest(deps, signRequest(NEW_SECRET, BODY, SLACK_NOW))).toEqual(
      ok(undefined),
    );
  });

  it("a failing verified-mark is logged and does not reject the request", async () => {
    const { deps, logger } = await setup();
    deps.settingsStore.markSecretVerified = async () => {
      throw new Error("db down");
    };
    expect(await verifySlackRequest(deps, signRequest(SIGNING_SECRET, BODY, SLACK_NOW))).toEqual(
      ok(undefined),
    );
    expect(logger.entries.map((e) => e.msg)).toContain("signing secret not marked verified");
  });
});
