import type { LlmSettingsView } from "../../../../application/settings/llm-settings";

const SAVED = "2026-11-04T03:00:00.000Z";

/** Nothing stored. */
export function llmNotConfigured(): LlmSettingsView {
  return {
    availability: "not_configured",
    active: null,
    anthropic: {
      credentialType: null,
      credential: { state: "unset" },
      baseUrl: null,
      model: null,
      defaultModel: "claude-opus-5-5",
    },
  };
}

/** Anthropic active on a gateway, verified. */
export function anLlmView(over: Partial<LlmSettingsView> = {}): LlmSettingsView {
  const base = llmNotConfigured();
  return {
    ...base,
    availability: "ready",
    active: "anthropic",
    anthropic: {
      ...base.anthropic,
      credentialType: "api_key",
      credential: {
        state: "set",
        last4: "AK01",
        savedAt: SAVED,
        verifiedAt: SAVED,
        model: "claude-opus-5-5",
        latencyMs: 321,
      },
      baseUrl: "https://gateway.example.test",
    },
    ...over,
  };
}
