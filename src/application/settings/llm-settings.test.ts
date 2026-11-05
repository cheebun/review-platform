import { beforeEach, describe, expect, it } from "vitest";
import { fakeSecretCiphers } from "../../testing/fakes/in-memory-settings-store";
import {
  getLlmSettingsView,
  LLM_SAVE_LIMIT,
  removeAnthropicSettings,
  saveAnthropicSettings,
  testAnthropicSettings,
} from "./llm-settings";
import {
  ANTHROPIC_KEY,
  ANTHROPIC_KEY_2,
  ANTHROPIC_TOKEN,
  GATEWAY,
  LLM_NOW,
  llmSettingsSetup,
} from "./llm-testing";
import { alice, machine } from "./testing";

let s: ReturnType<typeof llmSettingsSetup>;
beforeEach(() => {
  s = llmSettingsSetup();
});
const input = (over: Record<string, unknown> = {}) => ({
  baseUrl: GATEWAY,
  model: "runtime-model",
  apiKey: ANTHROPIC_KEY,
  ...over,
});
const events = () => s.reviewEvents.list({ limit: 50 });
const expectNoSecret = (value: unknown) => {
  for (const key of [ANTHROPIC_KEY, ANTHROPIC_KEY_2, ANTHROPIC_TOKEN])
    expect(JSON.stringify(value)).not.toContain(key);
};

describe("independent save and test actions", () => {
  it("starts unconfigured and exposes only Anthropic settings", async () => {
    const r = await getLlmSettingsView(s.deps, alice);
    expect(r).toMatchObject({
      ok: true,
      value: {
        active: null,
        availability: "not_configured",
        anthropic: { model: null, credential: { state: "unset" } },
      },
    });
    expect(r.ok && r.value).not.toHaveProperty("openai");
  });

  it("saves encrypted settings without probing or claiming verification", async () => {
    s.answerProbe({ kind: "error", latencyMs: 5, status: 401 });
    const result = await saveAnthropicSettings(s.deps, alice, input());
    expect(result).toMatchObject({
      ok: true,
      value: {
        view: {
          anthropic: { model: "runtime-model", credential: { state: "set", verifiedAt: null } },
        },
      },
    });
    expect(s.probes).toHaveLength(0);
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toMatchObject({
      state: "ready",
      meta: { verifiedAt: null, testResult: null },
    });
    expect(await s.settingsStore.getValues(["anthropic_model"])).toEqual({
      anthropic_model: "runtime-model",
    });
    expectNoSecret(result);
    expectNoSecret(await events());
    expectNoSecret(s.logger.entries);
    const rotated = s.settingsStore.withCiphers(fakeSecretCiphers(1));
    expect(await rotated.getSecret("anthropic_api_key")).toMatchObject({ state: "needs_reset" });
  });

  it("tests current inputs without saving secrets, values, metadata or history", async () => {
    const result = await testAnthropicSettings(s.deps, alice, input());
    expect(result).toMatchObject({ ok: true, value: { model: "claude-haiku-5-5" } });
    expect(s.probes[0]).toMatchObject({ model: "claude-haiku-5-5", baseUrl: GATEWAY });
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toEqual({
      state: "not_configured",
    });
    expect(await s.settingsStore.getValues(["anthropic_model"])).toEqual({});
    expect(await events()).toHaveLength(0);
    expectNoSecret(result);
  });

  it("a successful test of exactly the saved settings marks the saved credential verified", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    s.clock.advance(60_000);
    const result = await testAnthropicSettings(s.deps, alice, input());
    const verifiedAt = new Date(LLM_NOW.getTime() + 60_000).toISOString();
    expect(result).toMatchObject({
      ok: true,
      value: { verdict: "verified", view: { anthropic: { credential: { verifiedAt } } } },
    });
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toMatchObject({
      meta: { verifiedAt: new Date(verifiedAt) },
    });
    // The masked (empty) credential means the saved one, so it matches too.
    s.clock.advance(60_000);
    await testAnthropicSettings(s.deps, alice, input({ apiKey: "" }));
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toMatchObject({
      meta: { verifiedAt: s.clock.now() },
    });
    expect(await events()).toHaveLength(1);
    expectNoSecret(result);
  });

  it.each([
    ["another key", { apiKey: ANTHROPIC_KEY_2 }],
    ["another base URL", { apiKey: "", baseUrl: "https://other.example.test" }],
    ["another model", { apiKey: "", model: "unsaved-model" }],
    ["another credential type", { apiKey: "", authToken: ANTHROPIC_KEY }],
  ])("a successful test of an unsaved draft (%s) records nothing", async (_name, over) => {
    await saveAnthropicSettings(s.deps, alice, input());
    const before = await s.settingsStore.getSecret("anthropic_api_key");
    const result = await testAnthropicSettings(s.deps, alice, input(over));
    expect(result).toMatchObject({ ok: true, value: { verdict: "verified", view: null } });
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toEqual(before);
    expect(await s.settingsStore.getSecret("anthropic_auth_token")).toEqual({
      state: "not_configured",
    });
    expect(await events()).toHaveLength(1);
  });

  it("a failed test of the saved settings keeps an existing verification", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    await testAnthropicSettings(s.deps, alice, input());
    const verified = await s.settingsStore.getSecret("anthropic_api_key");
    expect(verified).toMatchObject({ meta: { verifiedAt: LLM_NOW } });
    for (const status of [401, 503]) {
      s.answerProbe({ kind: "error", latencyMs: 5, status });
      s.clock.advance(60_000);
      expect(await testAnthropicSettings(s.deps, alice, input())).toMatchObject({ ok: false });
      expect(await s.settingsStore.getSecret("anthropic_api_key")).toEqual(verified);
    }
  });

  it("saving after a verified test makes the credential unverified again", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    await testAnthropicSettings(s.deps, alice, input());
    const r = await saveAnthropicSettings(s.deps, alice, input({ apiKey: ANTHROPIC_KEY_2 }));
    expect(r).toMatchObject({
      ok: true,
      value: { view: { anthropic: { credential: { state: "set", verifiedAt: null } } } },
    });
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toMatchObject({
      meta: { verifiedAt: null },
    });
  });

  it("a store failure while recording verification still reports the probe", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    s.settingsStore.markSecretVerified = async () => {
      throw new Error("db down");
    };
    expect(await testAnthropicSettings(s.deps, alice, input())).toMatchObject({
      ok: true,
      value: { verdict: "verified", view: null },
    });
    expect(s.logger.entries).toContainEqual(
      expect.objectContaining({ msg: "llm credential not marked verified" }),
    );
  });

  it("a failed test does not prevent saving the same form", async () => {
    s.answerProbe({ kind: "error", latencyMs: 5, status: 503 });
    expect(await testAnthropicSettings(s.deps, alice, input())).toMatchObject({
      ok: false,
      error: { kind: "upstream" },
    });
    expect(await saveAnthropicSettings(s.deps, alice, input())).toMatchObject({ ok: true });
    expect(s.probes).toHaveLength(1);
  });

  it("uses a masked stored key for testing while leaving the stored model and history unchanged", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    const before = await s.settingsStore.getSecret("anthropic_api_key");
    await testAnthropicSettings(
      s.deps,
      alice,
      input({ apiKey: "", model: "unsaved-model", baseUrl: "https://other.example.test" }),
    );
    expect(s.probes[0]).toMatchObject({
      credential: { kind: "api_key", value: ANTHROPIC_KEY },
      model: "claude-haiku-5-5",
      baseUrl: "https://other.example.test",
    });
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toEqual(before);
    expect(await s.settingsStore.getValues(["anthropic_model"])).toEqual({
      anthropic_model: "runtime-model",
    });
    expect(await events()).toHaveLength(1);
  });

  it("keeps a stored credential on save and switches credential types atomically", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    expect(
      await saveAnthropicSettings(s.deps, alice, input({ apiKey: "", model: "next-model" })),
    ).toMatchObject({ ok: true });
    await saveAnthropicSettings(s.deps, alice, input({ apiKey: "", authToken: ANTHROPIC_TOKEN }));
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toEqual({
      state: "not_configured",
    });
    expect(await s.settingsStore.getSecret("anthropic_auth_token")).toMatchObject({
      state: "ready",
      value: ANTHROPIC_TOKEN,
    });
    await testAnthropicSettings(s.deps, alice, input({ apiKey: "" }));
    expect(s.probes[0]).toMatchObject({
      credential: { kind: "auth_token", value: ANTHROPIC_TOKEN },
    });
  });

  it.each([saveAnthropicSettings, testAnthropicSettings])(
    "validates both actions before requests or writes",
    async (action) => {
      for (const bad of [
        input({ authToken: ANTHROPIC_TOKEN }),
        input({ apiKey: "" }),
        input({ baseUrl: "ftp://bad" }),
        input({ model: "bad model" }),
      ]) {
        expect(await action(s.deps, alice, bad)).toMatchObject({
          ok: false,
          error: { kind: "validation" },
        });
      }
      expect(s.probes).toHaveLength(0);
      expect(await events()).toHaveLength(0);
      expect(await action(s.deps, machine, input())).toMatchObject({
        ok: false,
        error: { kind: "forbidden" },
      });
    },
  );

  it.each([401, 403, 404, 429, 500, undefined])(
    "maps failed tests safely without changing existing settings (%s)",
    async (status) => {
      await saveAnthropicSettings(s.deps, alice, input());
      const before = await s.settingsStore.getSecret("anthropic_api_key");
      s.answerProbe({ kind: "error", latencyMs: 5, ...(status ? { status } : {}) });
      const r = await testAnthropicSettings(s.deps, alice, input({ apiKey: ANTHROPIC_KEY_2 }));
      const kind =
        status === 401 || status === 403 ? "forbidden" : status === 404 ? "validation" : "upstream";
      expect(r).toMatchObject({ ok: false, error: { kind } });
      expect(await s.settingsStore.getSecret("anthropic_api_key")).toEqual(before);
      expect(await events()).toHaveLength(1);
      expectNoSecret(r);
    },
  );

  it("exhausting the test budget does not exhaust the save budget", async () => {
    for (let i = 0; i < LLM_SAVE_LIMIT.limit; i++)
      await testAnthropicSettings(s.deps, alice, input());
    expect(await testAnthropicSettings(s.deps, alice, input())).toMatchObject({
      ok: false,
      error: { kind: "rate_limited" },
    });
    expect(await saveAnthropicSettings(s.deps, alice, input())).toMatchObject({ ok: true });
  });

  it("saving is independently rate limited", async () => {
    for (let i = 0; i < LLM_SAVE_LIMIT.limit; i++)
      await saveAnthropicSettings(s.deps, alice, input());
    expect(await saveAnthropicSettings(s.deps, alice, input())).toMatchObject({
      ok: false,
      error: { kind: "rate_limited" },
    });
    expect(s.probes).toHaveLength(0);
  });

  it("fails closed for an unreadable masked credential", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    const deps = { ...s.deps, settingsStore: s.settingsStore.withCiphers(fakeSecretCiphers(1)) };
    expect(await testAnthropicSettings(deps, alice, input({ apiKey: "" }))).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "credential" },
    });
    expect(await getLlmSettingsView(deps, alice)).toMatchObject({
      value: { availability: "needs_reset" },
    });
  });

  it("a failed history event rolls back the entire save", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    s.reviewEvents.failNextAppend();
    await expect(
      saveAnthropicSettings(
        s.deps,
        alice,
        input({ apiKey: "", authToken: ANTHROPIC_TOKEN, model: "next-model" }),
      ),
    ).rejects.toThrow();
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toMatchObject({
      value: ANTHROPIC_KEY,
    });
    expect(await s.settingsStore.getSecret("anthropic_auth_token")).toEqual({
      state: "not_configured",
    });
    expect(await s.settingsStore.getValues(["anthropic_model"])).toEqual({
      anthropic_model: "runtime-model",
    });
    expect(await events()).toHaveLength(1);
  });

  it("clears optional model and endpoint values to defaults", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    await saveAnthropicSettings(s.deps, alice, input({ apiKey: "", baseUrl: "", model: "" }));
    expect(await s.settingsStore.getValues(["anthropic_model", "anthropic_base_url"])).toEqual({});
  });

  it("removing Anthropic disables LLM without touching obsolete OpenAI records", async () => {
    await saveAnthropicSettings(s.deps, alice, input());
    expect(await removeAnthropicSettings(s.deps, alice)).toMatchObject({
      ok: true,
      value: { active: null, availability: "not_configured" },
    });
    expect(await s.settingsStore.getSecret("anthropic_api_key")).toEqual({
      state: "not_configured",
    });
    const count = (await events()).length;
    await removeAnthropicSettings(s.deps, alice);
    expect(await events()).toHaveLength(count);
  });
});
