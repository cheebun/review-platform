import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_TOKEN,
  channel,
  SIGNING_SECRET,
  slackSettingsSetup,
  USER_TOKEN,
} from "../application/settings/slack-testing";
import type { Actor } from "../domain/shared/actor";
import {
  loadSlackSettings,
  parseSlackChannelsBody,
  parseSlackSecretBody,
  parseSlackSecretKindBody,
  runListSlackChannels,
  runRemoveSlackSecret,
  runSaveSlackSecret,
  runSetSlackChannels,
  type SlackFnPorts,
} from "./settings-slack.logic";

const user: Actor = { kind: "user", userId: "u1", email: "a@example.com" };

let s: ReturnType<typeof slackSettingsSetup>;
let ports: SlackFnPorts;
beforeEach(() => {
  s = slackSettingsSetup();
  ports = s.deps;
});

describe("validators", () => {
  it("parseSlackSecretBody keeps a known kind and a bounded string value", () => {
    expect(parseSlackSecretBody({ kind: "slack_user_token", value: " v " })).toEqual({
      kind: "slack_user_token",
      value: " v ",
    });
    for (const bad of [
      undefined,
      null,
      [],
      { kind: "slack_app_token" },
      { kind: "github_token", value: "v" },
      { kind: "slack_app_token", value: 1 },
      { kind: "slack_app_token", value: "x".repeat(2001) },
      { kind: "slack_app_token", value: "v", extra: 1 },
    ]) {
      expect(() => parseSlackSecretBody(bad)).toThrow();
    }
  });

  it("rejects retired app-token save and remove payloads", () => {
    expect(() => parseSlackSecretBody({ kind: "slack_app_token", value: APP_TOKEN })).toThrow();
    expect(() => parseSlackSecretKindBody({ kind: "slack_app_token" })).toThrow();
  });

  it("does not expose historical app-token settings", async () => {
    await s.settingsStore.saveSecret(
      "slack_app_token",
      {
        value: APP_TOKEN,
        savedAt: s.clock.now(),
        savedByUserId: "u1",
        verifiedAt: s.clock.now(),
        testResult: null,
      },
      () => ({
        id: "historical-app-token",
        type: "slack_secret_saved",
        actor: { kind: "user", id: "u1" },
        at: s.clock.now(),
        source: "web",
      }),
    );
    const reads = vi.spyOn(s.settingsStore, "getSecret");
    const result = await loadSlackSettings(ports, user);
    expect(result).toMatchObject({ ok: true });
    if (result.ok)
      expect(Object.keys(result.value.secrets)).toEqual([
        "slack_user_token",
        "slack_signing_secret",
      ]);
    expect(reads).not.toHaveBeenCalledWith("slack_app_token");
    reads.mockRestore();
    expect(await s.settingsStore.getSecret("slack_app_token")).toMatchObject({
      state: "ready",
      value: APP_TOKEN,
    });
  });

  it("retired app-token actions cannot mutate historical credentials", async () => {
    const before = await s.settingsStore.getSecret("slack_app_token");
    for (const result of [
      await runSaveSlackSecret(ports, user, { kind: "slack_app_token", value: APP_TOKEN } as never),
      await runRemoveSlackSecret(ports, user, { kind: "slack_app_token" } as never),
    ])
      expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await s.settingsStore.getSecret("slack_app_token")).toEqual(before);
    expect(s.slackVerifier.calls).toEqual([]);
  });

  it("a validator error never echoes the value", () => {
    let caught: unknown;
    try {
      parseSlackSecretBody({ kind: "nope", value: USER_TOKEN });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(USER_TOKEN);
    expect(JSON.stringify(caught)).not.toContain(USER_TOKEN);
  });

  it("parseSlackSecretKindBody and parseSlackChannelsBody bound their shape", () => {
    expect(parseSlackSecretKindBody({ kind: "slack_user_token" })).toEqual({
      kind: "slack_user_token",
    });
    expect(() => parseSlackSecretKindBody({ kind: "x" })).toThrow();
    expect(parseSlackChannelsBody({ channels: ["C1AA"] })).toEqual({ channels: ["C1AA"] });
    for (const bad of [
      {},
      { channels: "C1" },
      { channels: [1] },
      { channels: Array.from({ length: 501 }, () => "C1AA") },
      { channels: ["x".repeat(65)] },
    ]) {
      expect(() => parseSlackChannelsBody(bad)).toThrow();
    }
  });
});

describe("Slack settings server function logic", () => {
  it("never returns a secret on any path", async () => {
    const responses: unknown[] = [];
    responses.push(await loadSlackSettings(ports, user));
    responses.push(
      await runSaveSlackSecret(ports, user, {
        kind: "slack_user_token",
        value: "xoxp-0000-FAKE-unknown-token-9999",
      }),
    );
    responses.push(
      await runSaveSlackSecret(ports, user, { kind: "slack_user_token", value: USER_TOKEN }),
    );
    responses.push(
      await runSaveSlackSecret(ports, user, {
        kind: "slack_signing_secret",
        value: SIGNING_SECRET,
      }),
    );
    s.slackVerifier.channels(USER_TOKEN, [channel("C1AA", "general")]);
    responses.push(await runListSlackChannels(ports, user));
    responses.push(await runSetSlackChannels(ports, user, { channels: ["C1AA"] }));
    responses.push(await runRemoveSlackSecret(ports, user, { kind: "slack_user_token" }));
    expect(responses.at(-1)).toMatchObject({ ok: true });
    const text = JSON.stringify([responses, s.logger.entries]);
    for (const secret of [USER_TOKEN, APP_TOKEN, SIGNING_SECRET]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(0, -4));
    }
  });

  it("puts a validation error on its form field", async () => {
    const r = await runSaveSlackSecret(ports, user, { kind: "slack_user_token", value: "nope" });
    expect(r).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "userToken", fieldMessage: expect.any(String) },
    });
  });

  it("puts a Slack rejection on the field of the kind being saved", async () => {
    const r = await runSaveSlackSecret(ports, user, {
      kind: "slack_user_token",
      value: "xoxp-0000-FAKE-unknown-token-9999",
    });
    expect(r).toMatchObject({
      ok: false,
      error: { kind: "forbidden", field: "userToken", fieldMessage: "Token rejected by Slack." },
    });
  });

  it("puts a channel error on the channels field", async () => {
    await runSaveSlackSecret(ports, user, { kind: "slack_user_token", value: USER_TOKEN });
    const r = await runSetSlackChannels(ports, user, { channels: ["C9ZZ"] });
    expect(r).toMatchObject({ ok: false, error: { kind: "validation", field: "channels" } });
  });

  it("carries needs_reset on not_configured", async () => {
    const r = await runListSlackChannels(ports, user);
    expect(r).toMatchObject({ ok: false, error: { kind: "not_configured" } });
  });

  it("maps a thrown error to internal and logs only its name", async () => {
    s.reviewEvents.failNextAppend(new Error(`boom ${SIGNING_SECRET}`));
    const r = await runSaveSlackSecret(ports, user, {
      kind: "slack_signing_secret",
      value: SIGNING_SECRET,
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "internal" } });
    expect(JSON.stringify([r, s.logger.entries])).not.toContain(SIGNING_SECRET);
  });
});
