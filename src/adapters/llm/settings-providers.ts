import {
  readAnthropicStored,
  selectLlmProvider,
  type AnthropicTarget,
  type LlmTarget,
} from "../../domain/settings/llm-settings";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { ReviewInput, Reviewer } from "../../ports/reviewer";
import type { SecretRead, SettingKey, SettingsStore } from "../../ports/settings-store";
import type { Logger } from "../../ports/system";
import type { AiReviewResult } from "../../domain/review/types";
import { AnthropicReviewer } from "./anthropic-reviewer";
import type { AnthropicAdapterOptions, LlmCallOptions } from "./options";

/** What the settings-backed LLM code reads. */
export type LlmSettingsReader = Pick<SettingsStore, "getSecret" | "getValues">;

/** Composition-root extras passed to every adapter built. */
export type LlmAdapterExtras = {
  logger?: Logger;
  clientFactory?: AnthropicAdapterOptions["clientFactory"];
};

/*
 * The reviewer port with the per-call `AbortSignal` (`LlmCallOptions`). Structurally the port
 * interface plus one optional argument, so it is assignable to the port.
 */
export interface LlmReviewer extends Reviewer {
  review(input: ReviewInput, options?: LlmCallOptions): Promise<Result<AiReviewResult>>;
}
/** The source reads the store when called: no restart is needed after a change. */
export type LlmProviderSources = {
  reviewer: () => Promise<Result<LlmReviewer>>;
};

const NOT_CONFIGURED: DomainError = { kind: "not_configured", feature: "llm" };
const NEEDS_RESET: DomainError = { kind: "not_configured", feature: "llm", reason: "needs_reset" };

const ANTHROPIC_KEYS = [
  "anthropic_base_url",
  "anthropic_model",
] as const satisfies readonly SettingKey[];
const readyValue = (read: SecretRead): string | undefined =>
  read.state === "ready" ? read.value : undefined;

/**
 * The provider to use now, from the stored settings (FR-LLMCFG-01): Anthropic if configured,
 * otherwise `not_configured`. A secret that cannot be decrypted, or a stored
 * value that no longer passes the save rules, is `needs_reset` (fail closed). Store failures
 * reject: they are not a configuration state.
 */
export async function loadLlmTarget(store: LlmSettingsReader): Promise<Result<LlmTarget>> {
  const [apiKey, authToken] = await Promise.all([
    store.getSecret("anthropic_api_key"),
    store.getSecret("anthropic_auth_token"),
  ]);
  const selected = selectLlmProvider({
    anthropic_api_key: apiKey.state,
    anthropic_auth_token: authToken.state,
  });
  if (selected.provider === null) {
    return err(selected.reason === "needs_reset" ? NEEDS_RESET : NOT_CONFIGURED);
  }

  if (selected.provider === "anthropic") {
    const runtime = readAnthropicStored(await store.getValues(ANTHROPIC_KEYS));
    if (!runtime.ok) return err(NEEDS_RESET);
    // Exactly one is stored (the save rule); a token wins, as in the adapter, if both ever are.
    const token = readyValue(authToken);
    const key = readyValue(apiKey);
    const credential: AnthropicTarget["credential"] = token
      ? { kind: "auth_token", value: token }
      : { kind: "api_key", value: key! };
    return ok({ provider: "anthropic", ...runtime.value, credential });
  }

  return err(NOT_CONFIGURED);
}

/** Adapter options of an Anthropic target. A missing base URL becomes the official one. */
export function anthropicAdapterOptions(
  target: AnthropicTarget,
  extras: LlmAdapterExtras = {},
): AnthropicAdapterOptions {
  return {
    ...(target.credential.kind === "auth_token"
      ? { authToken: target.credential.value }
      : { apiKey: target.credential.value }),
    ...(target.baseUrl ? { baseURL: target.baseUrl } : {}),
    model: target.model,
    ...(extras.logger ? { logger: extras.logger } : {}),
    ...(extras.clientFactory ? { clientFactory: extras.clientFactory } : {}),
  };
}

/**
 * The reviewer, built per call from the `SettingsStore`. The
 * source resolves the provider when called and returns `not_configured` (feature `llm`) when
 * nothing usable is stored, so callers fail with 503 without a restart. No caching: a change on
 * `/settings` applies to the next call, and a store read costs far less than an LLM call.
 */
export function createLlmProvidersFromSettings(
  store: LlmSettingsReader,
  extras: LlmAdapterExtras = {},
): LlmProviderSources {
  const build = async <T>(anthropic: (o: AnthropicAdapterOptions) => T): Promise<Result<T>> => {
    const target = await loadLlmTarget(store);
    if (!target.ok) return target;
    return ok(anthropic(anthropicAdapterOptions(target.value, extras)));
  };
  return {
    reviewer: () => build<LlmReviewer>((o) => new AnthropicReviewer(o)),
  };
}
