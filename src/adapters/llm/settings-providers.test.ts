import { http } from "msw";
import { describe, expect, it } from "vitest";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import type { SecretKind, SettingValues } from "../../ports/settings-store";
import {
  fakeSecretCiphers,
  InMemorySettingsStore,
} from "../../testing/fakes/in-memory-settings-store";
import { anthropicTransport } from "../../testing/http/llm";
import { anthropicStream } from "../../testing/http/llm/anthropic";
import { server } from "../../testing/http/server";
import { createLlmProvidersFromSettings, loadLlmTarget } from "./settings-providers";

// Test sentinels, never real credentials.
const A_KEY = "test-anthropic-settings-key-0001";
const A_TOKEN = "test-anthropic-settings-token-0002";
const O_KEY = "test-openai-settings-key-0003";
const GATEWAY = "https://gateway.example.test";
const AT = new Date("2026-11-04T03:00:00.000Z");

const event = (): NewReviewEvent => ({
  id: "e",
  type: "settings_value_saved",
  actor: { kind: "user", id: "u1" },
  at: AT,
});

async function seed(
  store: InMemorySettingsStore,
  secrets: Partial<Record<SecretKind, string>>,
  values: Partial<SettingValues> = {},
) {
  for (const [kind, value] of Object.entries(secrets)) {
    await store.saveSecret(
      kind as SecretKind,
      { value: value!, savedAt: AT, savedByUserId: "u1", verifiedAt: AT, testResult: null },
      event,
    );
  }
  await store.saveValues(values, { at: AT, by: "u1", event });
}

const review = {
  owner: "o",
  repo: "r",
  number: 1,
  title: "t",
  body: "",
  author: "a",
  base: "main",
  head: "f",
  diffText: "diff",
};
const REVIEW_OK = { summary: "ok", findings: [] };
const NOT_CONFIGURED = { ok: false, error: { kind: "not_configured", feature: "llm" } };

function gateway() {
  const seen: { headers: Record<string, string>; body: Record<string, any> }[] = [];
  server.use(
    http.post(`${GATEWAY}/v1/messages`, async ({ request }) => {
      seen.push({
        headers: Object.fromEntries(request.headers),
        body: (await request.json()) as Record<string, any>,
      });
      return anthropicStream({ text: JSON.stringify(REVIEW_OK), stopReason: "end_turn" });
    }),
  );
  return seen;
}

describe("createLlmProvidersFromSettings", () => {
  it("ignores obsolete OpenAI credentials instead of selecting them", async () => {
    const store = new InMemorySettingsStore();
    await seed(store, { openai_api_key: O_KEY });
    expect(await loadLlmTarget(store)).toEqual(NOT_CONFIGURED);
    const llm = createLlmProvidersFromSettings(store);
    expect(await llm.reviewer()).toEqual(NOT_CONFIGURED);
  });

  it("nothing stored: the reviewer is not_configured (feature llm)", async () => {
    const llm = createLlmProvidersFromSettings(new InMemorySettingsStore());
    expect(await llm.reviewer()).toEqual(NOT_CONFIGURED);
  });

  it("Anthropic API key in x-api-key mode, on the stored gateway and model", async () => {
    const store = new InMemorySettingsStore();
    await seed(
      store,
      { anthropic_api_key: A_KEY },
      {
        anthropic_base_url: GATEWAY,
        anthropic_model: "claude-sonnet-5-5",
        anthropic_auth_header: "bearer",
        anthropic_server_fallback: true,
      },
    );
    const seen = gateway();
    const reviewer = await createLlmProvidersFromSettings(store).reviewer();
    expect(reviewer.ok).toBe(true);
    const result = reviewer.ok ? await reviewer.value.review(review) : null;
    expect(result).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["x-api-key"]).toBe(A_KEY);
    expect(seen[0]!.headers["authorization"]).toBeUndefined();
    expect(seen[0]!.body["model"]).toBe("claude-sonnet-5-5");
    // Obsolete saved header and fallback values cannot change outgoing requests.
    expect(seen[0]!.headers["anthropic-beta"]).toBeUndefined();
    expect(seen[0]!.body).not.toHaveProperty("fallbacks");
  });

  it("Anthropic auth token: bearer; the configured runtime model without fallback", async () => {
    const store = new InMemorySettingsStore();
    await seed(store, { anthropic_auth_token: A_TOKEN });
    const t = anthropicTransport();
    t.script({ kind: "json", value: REVIEW_OK });
    const reviewer = await createLlmProvidersFromSettings(store).reviewer();
    if (!reviewer.ok) throw new Error("expected a reviewer");
    expect((await reviewer.value.review(review)).ok).toBe(true);
    expect(t.headers[0]!["authorization"]).toBe(`Bearer ${A_TOKEN}`);
    expect(t.headers[0]!["x-api-key"]).toBeUndefined();
    expect(t.headers[0]!["anthropic-beta"]).toBeUndefined();
    expect(t.requests[0]).not.toHaveProperty("fallbacks");
    expect(t.requests[0]!.model).toBe("claude-opus-5-5");
  });

  it("removing Anthropic disables all providers even when obsolete OpenAI secrets exist", async () => {
    const store = new InMemorySettingsStore();
    await seed(store, { anthropic_api_key: A_KEY, openai_api_key: O_KEY });
    const llm = createLlmProvidersFromSettings(store);
    expect((await llm.reviewer()).ok).toBe(true);
    await store.removeSecret("anthropic_api_key", event);
    expect(await llm.reviewer()).toEqual(NOT_CONFIGURED);
  });

  it("an undecryptable Anthropic secret is needs_reset, never a switch to OpenAI", async () => {
    const store = new InMemorySettingsStore();
    await seed(store, { anthropic_api_key: A_KEY, openai_api_key: O_KEY });
    const rotated = store.withCiphers(fakeSecretCiphers(1));
    expect(await createLlmProvidersFromSettings(rotated).reviewer()).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "llm", reason: "needs_reset" },
    });
  });

  it("the source's adapters take an AbortSignal", async () => {
    const store = new InMemorySettingsStore();
    await seed(store, { anthropic_api_key: A_KEY }, { anthropic_base_url: GATEWAY });
    const seen = gateway();
    const reviewer = await createLlmProvidersFromSettings(store).reviewer();
    if (!reviewer.ok) throw new Error("expected a reviewer");
    const controller = new AbortController();
    controller.abort();
    expect(await reviewer.value.review(review, { signal: controller.signal })).toEqual({
      ok: false,
      error: { kind: "upstream", service: "llm", retryable: false },
    });
    expect(seen).toHaveLength(0);
  });
});

describe("loadLlmTarget", () => {
  it("a tampered stored value fails closed as needs_reset", async () => {
    const store = new InMemorySettingsStore();
    await seed(store, { anthropic_api_key: A_KEY }, { anthropic_model: "bad model" });
    expect(await loadLlmTarget(store)).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "llm", reason: "needs_reset" },
    });
  });

  it("resolves Anthropic defaults without obsolete header/fallback settings", async () => {
    const store = new InMemorySettingsStore();
    await seed(
      store,
      { anthropic_auth_token: A_TOKEN },
      { anthropic_auth_header: "x-api-key", anthropic_server_fallback: true },
    );
    expect(await loadLlmTarget(store)).toEqual({
      ok: true,
      value: {
        provider: "anthropic",
        credential: { kind: "auth_token", value: A_TOKEN },
        baseUrl: null,
        model: "claude-opus-5-5",
      },
    });
  });
});
