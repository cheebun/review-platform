import { beforeEach, describe, expect, it } from "vitest";
import { fakeSecretCiphers } from "../../testing/fakes/in-memory-settings-store";
import { SLACK_SETTINGS_CHANGED_CHANNEL } from "../slack/credentials";
import {
  CHANNEL_LIST_MAX_PAGES,
  getSlackSettingsView,
  listSlackChannels,
  removeSlackSecret,
  resolveSlackUserToken,
  saveSlackSecret,
  setSlackReviewChannels,
  SLACK_SAVE_LIMIT,
} from "./slack-settings";
import {
  APP_TOKEN,
  BOT_LIKE_USER_TOKEN,
  channel,
  SIGNING_SECRET,
  SLACK_NOW,
  slackSettingsSetup,
  USER_TOKEN,
  USER_TOKEN_2,
} from "./slack-testing";
import { alice, machine } from "./testing";

let s: ReturnType<typeof slackSettingsSetup>;
beforeEach(() => {
  s = slackSettingsSetup();
});

const events = async () => s.reviewEvents.list({ limit: 50 });
const saveUserToken = async (value = USER_TOKEN) => {
  const r = await saveSlackSecret(s.deps, alice, { kind: "slack_user_token", value });
  expect(r.ok).toBe(true);
  return r;
};
const ALL_SECRETS = [USER_TOKEN, USER_TOKEN_2, APP_TOKEN, SIGNING_SECRET];
const expectNoSecretIn = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
};

describe("getSlackSettingsView", () => {
  it("starts unconfigured with every secret unset and no channels", async () => {
    expect(await getSlackSettingsView(s.deps, alice)).toEqual({
      ok: true,
      value: {
        availability: "not_configured",
        secrets: {
          slack_user_token: { state: "unset" },
          slack_signing_secret: { state: "unset" },
        },
        channels: [],
        maxChannels: 200,
      },
    });
  });

  it("refuses a non-user actor", async () => {
    expect(await getSlackSettingsView(s.deps, machine)).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });

  it("reports needs_reset when a stored secret cannot be decrypted", async () => {
    await saveUserToken();
    const rotated = { ...s.deps, settingsStore: s.settingsStore.withCiphers(fakeSecretCiphers(1)) };
    const r = await getSlackSettingsView(rotated, alice);
    expect(r).toMatchObject({
      ok: true,
      value: {
        availability: "needs_reset",
        secrets: { slack_user_token: { state: "needs_reset", last4: "0001" } },
      },
    });
  });
});

describe("saveSlackSecret: user token", () => {
  it("runs auth.test, stores the owner and team, marks it verified and records the event", async () => {
    const r = await saveSlackSecret(s.deps, alice, {
      kind: "slack_user_token",
      value: `  ${USER_TOKEN}\n`,
    });
    expect(r).toMatchObject({
      ok: true,
      value: {
        availability: "ready",
        secrets: {
          slack_user_token: {
            state: "set",
            last4: "0001",
            savedAt: SLACK_NOW.toISOString(),
            verifiedAt: SLACK_NOW.toISOString(),
            teamName: "Acme",
            userName: "me",
          },
        },
      },
    });
    expectNoSecretIn(r);
    const read = await s.settingsStore.getSecret("slack_user_token");
    expect(read).toMatchObject({
      state: "ready",
      value: USER_TOKEN,
      meta: {
        savedByUserId: "u-alice",
        testResult: { userId: "U1", teamId: "T1", teamName: "Acme", userName: "me" },
      },
    });
    const [event] = await events();
    expect(event).toMatchObject({
      type: "slack_secret_saved",
      actor: { kind: "user", id: "u-alice" },
      at: SLACK_NOW,
      source: "web",
      detail: { kind: "slack_user_token", last4: "0001", replaced: false },
    });
    expectNoSecretIn(event);
    expectNoSecretIn(s.logger.entries);
  });

  it("marks a replacement as replaced", async () => {
    await saveUserToken();
    await saveUserToken(USER_TOKEN_2);
    const [latest] = await events();
    expect(latest?.detail).toMatchObject({ last4: "0002", replaced: true });
  });

  it("rejects a token whose auth.test identity is a bot; nothing is stored", async () => {
    const r = await saveSlackSecret(s.deps, alice, {
      kind: "slack_user_token",
      value: BOT_LIKE_USER_TOKEN,
    });
    expect(r).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "userToken" },
    });
    expect(await s.settingsStore.getSecret("slack_user_token")).toEqual({
      state: "not_configured",
    });
  });

  it("maps a token Slack rejects to forbidden; nothing is stored", async () => {
    const r = await saveSlackSecret(s.deps, alice, {
      kind: "slack_user_token",
      value: "xoxp-0000-FAKE-unknown-token-9999",
    });
    expect(r).toEqual({
      ok: false,
      error: { kind: "forbidden", reason: "Token rejected by Slack." },
    });
    expect(await events()).toEqual([]);
  });

  it("passes an upstream failure through; nothing is stored", async () => {
    s.slackVerifier.failNext("server_error");
    const r = await saveSlackSecret(s.deps, alice, { kind: "slack_user_token", value: USER_TOKEN });
    expect(r).toMatchObject({ ok: false, error: { kind: "upstream", service: "slack" } });
    expect(await s.settingsStore.getSecret("slack_user_token")).toEqual({
      state: "not_configured",
    });
  });

  it("never calls Slack for a malformed value", async () => {
    const r = await saveSlackSecret(s.deps, alice, {
      kind: "slack_user_token",
      value: "xoxb-0000-FAKE-bot-token-000000",
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "validation", field: "userToken" } });
    expect(s.slackVerifier.calls).toEqual([]);
  });
});

describe("saveSlackSecret: signing secret", () => {
  it("stores the signing secret on a format check only, unverified", async () => {
    const r = await saveSlackSecret(s.deps, alice, {
      kind: "slack_signing_secret",
      value: SIGNING_SECRET,
    });
    expect(r).toMatchObject({
      ok: true,
      value: {
        availability: "not_configured",
        secrets: { slack_signing_secret: { state: "set", last4: "cdef", verifiedAt: null } },
      },
    });
    expect(s.slackVerifier.calls).toEqual([]);
  });

  it("rejects an unknown kind", async () => {
    const r = await saveSlackSecret(s.deps, alice, { kind: "github_token", value: SIGNING_SECRET });
    expect(r).toMatchObject({ ok: false, error: { kind: "validation", field: "kind" } });
  });

  it("refuses a non-user actor before anything else", async () => {
    const r = await saveSlackSecret(s.deps, machine, {
      kind: "slack_user_token",
      value: USER_TOKEN,
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(s.slackVerifier.calls).toEqual([]);
  });

  it("rate limits saves per user", async () => {
    for (let i = 0; i < SLACK_SAVE_LIMIT.limit; i++) {
      await saveSlackSecret(s.deps, alice, { kind: "slack_signing_secret", value: SIGNING_SECRET });
    }
    const r = await saveSlackSecret(s.deps, alice, {
      kind: "slack_signing_secret",
      value: SIGNING_SECRET,
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "rate_limited" } });
  });

  it("does not store the secret when the event cannot be recorded", async () => {
    s.reviewEvents.failNextAppend();
    await expect(
      saveSlackSecret(s.deps, alice, { kind: "slack_signing_secret", value: SIGNING_SECRET }),
    ).rejects.toThrow();
    expect(await s.settingsStore.getSecret("slack_signing_secret")).toEqual({
      state: "not_configured",
    });
  });
});

describe("removeSlackSecret", () => {
  it("deletes the secret and records slack_secret_removed", async () => {
    await saveUserToken();
    const r = await removeSlackSecret(s.deps, alice, { kind: "slack_user_token" });
    expect(r).toMatchObject({
      ok: true,
      value: { availability: "not_configured", secrets: { slack_user_token: { state: "unset" } } },
    });
    const [event] = await events();
    expect(event).toMatchObject({
      type: "slack_secret_removed",
      detail: { kind: "slack_user_token", last4: "0001" },
    });
  });

  it("is a no-op without an event when nothing is stored", async () => {
    const r = await removeSlackSecret(s.deps, alice, { kind: "slack_signing_secret" });
    expect(r.ok).toBe(true);
    expect(await events()).toEqual([]);
  });

  it("rejects an unknown kind and a non-user actor", async () => {
    expect(await removeSlackSecret(s.deps, alice, { kind: "nope" })).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "kind" },
    });
    expect(await removeSlackSecret(s.deps, machine, { kind: "slack_app_token" })).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });
});

describe("Slack settings change notification", () => {
  /** Counts deliveries on the channel the worker and the web process listen to. */
  const listen = async () => {
    const seen = { count: 0 };
    await s.wakeUp.subscribe(SLACK_SETTINGS_CHANGED_CHANNEL, () => void (seen.count += 1));
    return seen;
  };
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("publishes once after each successful save of any secret", async () => {
    const seen = await listen();
    await saveUserToken();
    await saveSlackSecret(s.deps, alice, { kind: "slack_signing_secret", value: SIGNING_SECRET });
    await flush();
    expect(seen.count).toBe(2);
  });

  it("publishes after a removal, but not when nothing was stored", async () => {
    await saveUserToken();
    const seen = await listen();
    await removeSlackSecret(s.deps, alice, { kind: "slack_signing_secret" });
    await flush();
    expect(seen.count).toBe(0);
    await removeSlackSecret(s.deps, alice, { kind: "slack_user_token" });
    await flush();
    expect(seen.count).toBe(1);
  });

  it("does not publish when the save is refused", async () => {
    const seen = await listen();
    await saveSlackSecret(s.deps, alice, { kind: "slack_user_token", value: BOT_LIKE_USER_TOKEN });
    await saveSlackSecret(s.deps, alice, { kind: "slack_user_token", value: "nope" });
    await saveSlackSecret(s.deps, machine, { kind: "slack_user_token", value: USER_TOKEN });
    await flush();
    expect(seen.count).toBe(0);
  });

  it("a failing publish does not fail the save: the caches also expire on their own", async () => {
    s.deps.wakeUp = {
      notify: async () => {
        throw new Error("redis down");
      },
      subscribe: async () => async () => {},
    };
    const r = await saveSlackSecret(s.deps, alice, { kind: "slack_user_token", value: USER_TOKEN });
    expect(r.ok).toBe(true);
    expect(s.logger.entries.map((e) => e.msg)).toContain("slack settings change not published");
  });
});

describe("resolveSlackUserToken", () => {
  it("returns the token, not_configured or needs_reset", async () => {
    expect(await resolveSlackUserToken(s.deps)).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack" },
    });
    await saveUserToken();
    expect(await resolveSlackUserToken(s.deps)).toEqual({ ok: true, value: USER_TOKEN });
    const rotated = { ...s.deps, settingsStore: s.settingsStore.withCiphers(fakeSecretCiphers(1)) };
    expect(await resolveSlackUserToken(rotated)).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack", reason: "needs_reset" },
    });
  });
});

describe("listSlackChannels", () => {
  it("is not_configured without a user token", async () => {
    expect(await listSlackChannels(s.deps, alice)).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack" },
    });
  });

  it("lists the member channels across pages, sorted by name", async () => {
    await saveUserToken();
    const list = Array.from({ length: 450 }, (_, i) =>
      channel(`C${String(i).padStart(4, "0")}`, `chan-${String(449 - i).padStart(3, "0")}`, {
        isPrivate: i % 2 === 0,
        isMember: i !== 7,
      }),
    );
    s.slackVerifier.channels(USER_TOKEN, list);
    const r = await listSlackChannels(s.deps, alice);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(false);
    expect(r.value.channels).toHaveLength(449);
    expect(r.value.channels[0]).toEqual({ id: "C0449", name: "chan-000", isPrivate: false });
    expect(r.value.channels.some((c) => c.id === "C0007")).toBe(false);
    const pages = s.slackVerifier.calls.filter((c) => c.method === "listConversations");
    expect(pages.map((c) => c.cursor)).toEqual([undefined, "200", "400"]);
  });

  it("stops after the page cap and reports truncated", async () => {
    await saveUserToken();
    const list = Array.from({ length: CHANNEL_LIST_MAX_PAGES * 200 + 5 }, (_, i) =>
      channel(`C${i}AA`, `c-${i}`),
    );
    s.slackVerifier.channels(USER_TOKEN, list);
    const r = await listSlackChannels(s.deps, alice);
    expect(r).toMatchObject({ ok: true, value: { truncated: true } });
  });

  it("stops at the overall deadline and reports truncated", async () => {
    await saveUserToken();
    s.slackVerifier.channels(
      USER_TOKEN,
      Array.from({ length: 1000 }, (_, i) => channel(`C${i}AA`, `c-${i}`)),
    );
    const slow = {
      ...s.slackVerifier,
      listConversations: async (token: string, input: { cursor?: string; limit?: number }) => {
        s.clock.advance(10_000);
        return s.slackVerifier.listConversations(token, input);
      },
    };
    const r = await listSlackChannels({ ...s.deps, slackVerifier: slow as never }, alice);
    expect(r).toMatchObject({ ok: true, value: { truncated: true } });
    if (r.ok) expect(r.value.channels).toHaveLength(400);
  });

  it("flags selected channels that are gone and refreshes names of the rest", async () => {
    await saveUserToken();
    s.slackVerifier.channels(USER_TOKEN, [channel("C1AA", "general"), channel("C2BB", "random")]);
    await setSlackReviewChannels(s.deps, alice, { channels: ["C1AA", "C2BB"] });
    s.slackVerifier.channels(USER_TOKEN, [channel("C1AA", "general-renamed")]);
    await listSlackChannels(s.deps, alice);
    expect(await s.settingsStore.listReviewChannels()).toMatchObject([
      { channelId: "C1AA", name: "general-renamed", missing: false },
      { channelId: "C2BB", name: "random", missing: true },
    ]);
  });

  it("passes a Slack failure through", async () => {
    await saveUserToken();
    s.slackVerifier.failNext("rate_limited");
    expect(await listSlackChannels(s.deps, alice)).toMatchObject({
      ok: false,
      error: { kind: "rate_limited" },
    });
  });

  it("refuses a non-user actor", async () => {
    expect(await listSlackChannels(s.deps, machine)).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });
});

describe("setSlackReviewChannels", () => {
  beforeEach(async () => {
    await saveUserToken();
    s.slackVerifier.channels(USER_TOKEN, [
      channel("C1AA", "general"),
      channel("G2BB", "secret-ops", { isPrivate: true }),
    ]);
  });

  it("stores the selection with names from Slack and records the diff", async () => {
    const r = await setSlackReviewChannels(s.deps, alice, { channels: ["G2BB", "C1AA", "C1AA"] });
    expect(r).toMatchObject({
      ok: true,
      value: {
        channels: [
          { channelId: "C1AA", name: "general", missing: false },
          { channelId: "G2BB", name: "secret-ops", missing: false },
        ],
      },
    });
    const [event] = await events();
    expect(event).toMatchObject({
      type: "slack_channels_changed",
      detail: { added: 2, removed: 0, total: 2 },
    });
  });

  it("clears the selection without calling Slack (empty means all channels)", async () => {
    await setSlackReviewChannels(s.deps, alice, { channels: ["C1AA"] });
    const before = s.slackVerifier.calls.length;
    const r = await setSlackReviewChannels(s.deps, alice, { channels: [] });
    expect(r).toMatchObject({ ok: true, value: { channels: [] } });
    expect(s.slackVerifier.calls).toHaveLength(before);
    expect((await events())[0]?.detail).toMatchObject({ added: 0, removed: 1, total: 0 });
  });

  it("rejects a channel the user is not in", async () => {
    const r = await setSlackReviewChannels(s.deps, alice, { channels: ["C9ZZ"] });
    expect(r).toMatchObject({ ok: false, error: { kind: "validation", field: "channels" } });
    expect(await s.settingsStore.listReviewChannels()).toEqual([]);
  });

  it("keeps a previously selected channel that has since disappeared, flagged missing", async () => {
    await setSlackReviewChannels(s.deps, alice, { channels: ["C1AA", "G2BB"] });
    s.slackVerifier.channels(USER_TOKEN, [channel("C1AA", "general")]);
    const r = await setSlackReviewChannels(s.deps, alice, { channels: ["C1AA", "G2BB"] });
    expect(r).toMatchObject({
      ok: true,
      value: {
        channels: [
          { channelId: "C1AA", missing: false },
          { channelId: "G2BB", name: "secret-ops", missing: true },
        ],
      },
    });
  });

  it("rejects malformed ids and DMs", async () => {
    expect(await setSlackReviewChannels(s.deps, alice, { channels: ["D1AA"] })).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "channels" },
    });
  });

  it("needs a user token for a non-empty selection", async () => {
    await removeSlackSecret(s.deps, alice, { kind: "slack_user_token" });
    expect(await setSlackReviewChannels(s.deps, alice, { channels: ["C1AA"] })).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "slack" },
    });
  });

  it("refuses a non-user actor", async () => {
    expect(await setSlackReviewChannels(s.deps, machine, { channels: [] })).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });
});
