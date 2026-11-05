import type { NewReviewEvent } from "../ports/review-event-repo";
import type { SecretKind, SettingValues, SettingsStore } from "../ports/settings-store";

/**
 * Seeds LLM credentials into a `SettingsStore` (normally `InMemorySettingsStore`), the
 * only way tests get them since stage 4: never from env. Every default is an obviously fake
 * sentinel on a `.example.test` host, which only msw answers (`onUnhandledFrame` fails anything
 * else).
 */

const AT = new Date("2026-11-04T00:00:00.000Z");
const BY = "test-owner";

export const FAKE_ANTHROPIC = {
  values: { anthropic_base_url: "https://anthropic.example.test", anthropic_model: "fake-model" },
  secrets: { anthropic_api_key: "FAKE-anthropic-api-key-for-tests-0001" },
} as const satisfies SeedInput;

export const FAKE_OPENAI = {
  values: { openai_base_url: "https://openai.example.test", openai_model: "fake-model" },
  secrets: { openai_api_key: "FAKE-openai-api-key-for-tests-0001" },
} as const satisfies SeedInput;

export type SeedInput = {
  values?: Partial<SettingValues>;
  secrets?: Partial<Record<SecretKind, string>>;
};

let seq = 0;
const event = (): NewReviewEvent => ({
  id: `seed-${++seq}`,
  type: "settings_value_saved",
  actor: { kind: "user", id: BY },
  at: AT,
});

/** Saves `values` and `secrets` (as verified) through the store's own API. */
export async function seedSettings(
  store: Pick<SettingsStore, "saveValues" | "saveSecret">,
  { values = {}, secrets = {} }: SeedInput,
  at: Date = AT,
): Promise<void> {
  if (Object.keys(values).length > 0) await store.saveValues(values, { at, by: BY, event });
  for (const [kind, value] of Object.entries(secrets) as [SecretKind, string][]) {
    await store.saveSecret(
      kind,
      { value, savedAt: at, savedByUserId: BY, verifiedAt: at, testResult: null },
      event,
    );
  }
}

/** An LLM provider (Anthropic by default), each value overridable. */
export const seedLlmSettings = (
  store: Pick<SettingsStore, "saveValues" | "saveSecret">,
  provider: "anthropic" | "openai" = "anthropic",
  overrides: SeedInput = {},
) => {
  const base = provider === "anthropic" ? FAKE_ANTHROPIC : FAKE_OPENAI;
  return seedSettings(store, {
    values: { ...base.values, ...overrides.values },
    secrets: { ...base.secrets, ...overrides.secrets },
  });
};
