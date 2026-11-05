import { describe, expect, it } from "vitest";
import type { SecretKind, SecretRead, SettingsStore } from "../../ports/settings-store";
import { FakeClock } from "../../testing/fakes/fake-clock";
import {
  fakeSecretCiphers,
  InMemorySettingsStore,
} from "../../testing/fakes/in-memory-settings-store";
import { SIGNING_SECRET, SLACK_NOW, USER_TOKEN } from "../settings/slack-testing";
import {
  SLACK_CREDENTIAL_TTL_MS,
  SLACK_REFRESH_MIN_INTERVAL_MS,
  SlackCredentials,
} from "./credentials";

const event = () => ({
  id: "e",
  type: "slack_secret_saved" as const,
  actor: { kind: "user" as const, id: "u" },
  at: SLACK_NOW,
  source: "web" as const,
});

async function save(
  store: InMemorySettingsStore,
  kind: SecretKind,
  value: string,
  extra: { verifiedAt?: Date | null; testResult?: Record<string, string> | null } = {},
) {
  await store.saveSecret(
    kind,
    {
      value,
      savedAt: SLACK_NOW,
      savedByUserId: "u",
      verifiedAt: extra.verifiedAt ?? null,
      testResult: extra.testResult ?? null,
    },
    event,
  );
}

/** Counts reads so the cache is observable. */
class CountingStore {
  reads = 0;
  failNext = false;
  constructor(readonly inner: InMemorySettingsStore) {}
  async getSecret(kind: SecretKind): Promise<SecretRead> {
    this.reads += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("db down");
    }
    return this.inner.getSecret(kind);
  }
}

function setup() {
  const clock = new FakeClock(SLACK_NOW);
  const inner = new InMemorySettingsStore();
  const store = new CountingStore(inner);
  const credentials = new SlackCredentials({
    settingsStore: store as unknown as Pick<SettingsStore, "getSecret">,
    clock,
  });
  return { clock, inner, store, credentials };
}

describe("SlackCredentials", () => {
  it("a missing signing secret is not_configured slack_events", async () => {
    const { credentials } = setup();
    expect(await credentials.signingSecret()).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack_events" },
    });
  });

  it("passes needs_reset through", async () => {
    const { inner, clock } = setup();
    await save(inner, "slack_signing_secret", SIGNING_SECRET);
    const rotated = inner.withCiphers(fakeSecretCiphers(1));
    const credentials = new SlackCredentials({ settingsStore: rotated, clock });
    expect(await credentials.signingSecret()).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack_events", reason: "needs_reset" },
    });
  });

  it("returns the value, its version and whether it was verified", async () => {
    const { inner, credentials } = setup();
    await save(inner, "slack_signing_secret", SIGNING_SECRET);
    expect(await credentials.signingSecret()).toEqual({
      ok: true,
      value: { value: SIGNING_SECRET, version: 1, verified: false },
    });
  });

  it("caches a read for the TTL, then reads again", async () => {
    const { inner, store, clock, credentials } = setup();
    await save(inner, "slack_signing_secret", SIGNING_SECRET);
    await credentials.signingSecret();
    await credentials.signingSecret();
    expect(store.reads).toBe(1);
    clock.advance(SLACK_CREDENTIAL_TTL_MS + 1);
    await credentials.signingSecret();
    expect(store.reads).toBe(2);
  });

  it("caches not_configured too, until invalidated", async () => {
    const { inner, store, credentials } = setup();
    expect((await credentials.signingSecret()).ok).toBe(false);
    await save(inner, "slack_signing_secret", SIGNING_SECRET);
    expect((await credentials.signingSecret()).ok).toBe(false);
    credentials.invalidate();
    expect((await credentials.signingSecret()).ok).toBe(true);
    expect(store.reads).toBe(2);
  });

  it("concurrent callers share one read", async () => {
    const { inner, store, credentials } = setup();
    await save(inner, "slack_signing_secret", SIGNING_SECRET);
    await Promise.all([credentials.signingSecret(), credentials.signingSecret()]);
    expect(store.reads).toBe(1);
  });

  it("a store failure rejects and is not cached", async () => {
    const { inner, store, credentials } = setup();
    await save(inner, "slack_signing_secret", SIGNING_SECRET);
    store.failNext = true;
    await expect(credentials.signingSecret()).rejects.toThrow("db down");
    expect((await credentials.signingSecret()).ok).toBe(true);
  });

  it("refresh re-reads at most once per interval and reports a changed version", async () => {
    const { inner, store, clock, credentials } = setup();
    await save(inner, "slack_signing_secret", SIGNING_SECRET);
    await credentials.signingSecret();
    await save(inner, "slack_signing_secret", "f".repeat(32));
    expect(await credentials.refresh("slack_signing_secret")).toBe(true);
    expect(await credentials.signingSecret()).toMatchObject({ value: { version: 2 } });
    expect(await credentials.refresh("slack_signing_secret")).toBe(false);
    expect(store.reads).toBe(2);
    clock.advance(SLACK_REFRESH_MIN_INTERVAL_MS + 1);
    expect(await credentials.refresh("slack_signing_secret")).toBe(false);
    expect(store.reads).toBe(3);
  });

  it("owner comes from the user token's verified identity", async () => {
    const { inner, credentials } = setup();
    expect(await credentials.owner()).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack" },
    });
    credentials.invalidate();
    await save(inner, "slack_user_token", USER_TOKEN, {
      verifiedAt: SLACK_NOW,
      testResult: { userId: "U0OWNER", teamId: "T0ACME", teamName: "Acme", userName: "me" },
    });
    expect(await credentials.owner()).toEqual({
      ok: true,
      value: { userId: "U0OWNER", teamId: "T0ACME" },
    });
    expect(await credentials.userToken()).toEqual({ ok: true, value: USER_TOKEN });
  });

  it("a user token without a usable identity is not configured", async () => {
    const { inner, credentials } = setup();
    await save(inner, "slack_user_token", USER_TOKEN, { testResult: { userId: "<script>" } });
    expect(await credentials.owner()).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack" },
    });
  });

  it("marks a version verified in the cache", async () => {
    const { inner, store, credentials } = setup();
    await save(inner, "slack_signing_secret", SIGNING_SECRET);
    await credentials.signingSecret();
    credentials.markVerified("slack_signing_secret", 1);
    expect(await credentials.signingSecret()).toMatchObject({ value: { verified: true } });
    expect(store.reads).toBe(1);
  });
});
