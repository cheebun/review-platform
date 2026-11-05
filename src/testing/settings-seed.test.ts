import { describe, expect, it } from "vitest";
import { loadLlmTarget } from "../adapters/llm/settings-providers";
import { InMemorySettingsStore } from "./fakes/in-memory-settings-store";
import { FAKE_ANTHROPIC, FAKE_OPENAI, seedLlmSettings } from "./settings-seed";

describe("settings seed helpers", () => {
  it("an empty store is not configured for the LLM", async () => {
    const store = new InMemorySettingsStore();
    expect((await loadLlmTarget(store)).ok).toBe(false);
  });

  it("seedLlmSettings selects Anthropic and obsolete OpenAI records stay inactive", async () => {
    const anthropic = new InMemorySettingsStore();
    await seedLlmSettings(anthropic);
    const a = await loadLlmTarget(anthropic);
    expect(a.ok && a.value.provider).toBe("anthropic");
    expect(a.ok && a.value.provider === "anthropic" && a.value.credential.value).toBe(
      FAKE_ANTHROPIC.secrets.anthropic_api_key,
    );

    const openai = new InMemorySettingsStore();
    await seedLlmSettings(openai, "openai");
    const o = await loadLlmTarget(openai);
    expect(o).toMatchObject({ ok: false, error: { kind: "not_configured" } });
  });

  it("defaults are fake sentinels on hosts only msw answers", () => {
    for (const input of [FAKE_ANTHROPIC, FAKE_OPENAI]) {
      for (const v of Object.values(input.secrets)) expect(v).toMatch(/^FAKE-/);
      for (const [k, v] of Object.entries(input.values))
        if (k.endsWith("_base_url")) expect(new URL(v).hostname).toMatch(/\.example\.test$/);
    }
  });
});
