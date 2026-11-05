import { err, ok, type DomainError, type Result } from "../shared/result";
import type { SecretReadLike, SecretReadState } from "./slack-settings";

/*
 * FR-LLMCFG-01: the LLM section of `/settings`. Pure rules only; the use cases are in
 * `application/settings/llm-settings.ts`. Every message is fixed and never contains the input,
 * which may be a credential or a URL that carries one.
 */

/** Used when no Anthropic model is stored (`.env.example`). */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
/** Connection tests never use the configured runtime model. */
export const ANTHROPIC_PROBE_MODEL = "claude-haiku-5-5";
/** Used when no OpenAI model is stored; the default `Config` had. */
export const DEFAULT_OPENAI_MODEL = "gpt-6.1-sol";
export const LLM_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];
export const DEFAULT_OPENAI_REASONING_EFFORT: LlmReasoningEffort = "medium";

export const LLM_MODEL_MAX_LENGTH = 200;
/** Below `SETTING_VALUE_MAX_LENGTH` (2048) of the store. */
export const LLM_BASE_URL_MAX_LENGTH = 2000;
/**
 * Real keys are 40+ characters. The lower bound (assumed) keeps `last4` from revealing a large
 * share of a short value; the upper bound only caps the payload.
 */
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 1024;
const VISIBLE_RE = /^[\x21-\x7e]+$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/** The form fields of both sub-forms; validation errors land on them. */
export type LlmField = "baseUrl" | "model" | "apiKey" | "authToken" | "credential";

const invalid = (field: LlmField, message: string): { ok: false; error: DomainError } =>
  err({ kind: "validation", field, message });

const blank = (input: unknown): boolean =>
  input === undefined || input === null || (typeof input === "string" && input.trim() === "");

/**
 * An optional endpoint: empty means the official one (null). http or https, no credentials,
 * query or fragment (the SDKs append paths to it). The host is lower-cased by URL parsing and
 * trailing slashes are dropped, so `https://x/` and `https://x` are the same setting.
 */
export function parseLlmBaseUrl(input: unknown, field: LlmField): Result<string | null> {
  if (blank(input)) return ok(null);
  const message =
    "The base URL must be an http or https URL without credentials, query or fragment.";
  if (typeof input !== "string") return invalid(field, message);
  const text = input.trim();
  if (text.length > LLM_BASE_URL_MAX_LENGTH || !VISIBLE_RE.test(text)) {
    return invalid(field, message);
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid(field, message);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid(field, message);
  if (url.username !== "" || url.password !== "") return invalid(field, message);
  if (url.search !== "" || url.hash !== "" || text.includes("?") || text.includes("#")) {
    return invalid(field, message);
  }
  return ok(`${url.origin}${url.pathname.replace(/\/+$/, "")}`);
}

/** An optional model name: empty means the provider default (null). */
export function parseLlmModel(input: unknown, field: LlmField): Result<string | null> {
  if (blank(input)) return ok(null);
  const message = `A model name is letters, digits and . _ : / @ + - only, at most ${LLM_MODEL_MAX_LENGTH} characters.`;
  if (typeof input !== "string") return invalid(field, message);
  const value = input.trim();
  if (value.length > LLM_MODEL_MAX_LENGTH || !MODEL_RE.test(value)) return invalid(field, message);
  return ok(value);
}

/** A key or token. Surrounding whitespace (a pasted newline) is trimmed first. */
export function parseLlmSecret(input: unknown, field: LlmField): Result<string> {
  const message = `A key is ${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH} visible characters with no spaces.`;
  if (typeof input !== "string") return invalid(field, message);
  const value = input.trim();
  if (
    value.length < MIN_SECRET_LENGTH ||
    value.length > MAX_SECRET_LENGTH ||
    !VISIBLE_RE.test(value)
  ) {
    return invalid(field, message);
  }
  return ok(value);
}

export type AnthropicCredentialType = "api_key" | "auth_token";

export type AnthropicSettingsInput = {
  baseUrl: string | null;
  model: string | null;
  /** Null: keep the stored credential. */
  credential: { kind: AnthropicCredentialType; value: string } | null;
};

type RawAnthropic = {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  authToken?: unknown;
};

/** FR-LLMCFG-01, Anthropic: exactly one of an API key or an auth token (or neither: keep). */
export function parseAnthropicSettings(input: RawAnthropic): Result<AnthropicSettingsInput> {
  const hasKey = !blank(input.apiKey);
  const hasToken = !blank(input.authToken);
  if (hasKey && hasToken) {
    return invalid("credential", "Set an API key or an auth token, not both.");
  }
  const baseUrl = parseLlmBaseUrl(input.baseUrl, "baseUrl");
  if (!baseUrl.ok) return baseUrl;
  const model = parseLlmModel(input.model, "model");
  if (!model.ok) return model;
  let credential: AnthropicSettingsInput["credential"] = null;
  if (hasKey || hasToken) {
    const kind: AnthropicCredentialType = hasKey ? "api_key" : "auth_token";
    const value = parseLlmSecret(
      hasKey ? input.apiKey : input.authToken,
      hasKey ? "apiKey" : "authToken",
    );
    if (!value.ok) return value;
    credential = { kind, value: value.value };
  }
  return ok({
    baseUrl: baseUrl.value,
    model: model.value,
    credential,
  });
}

/** What one `llm:ping` probe saw. `status` is absent for network errors and timeouts. */
export type LlmProbeOutcome =
  | { kind: "ok"; latencyMs: number; model: string }
  | { kind: "error"; latencyMs: number; status?: number };

/**
 * Connection test verdicts describe the response and never change stored settings.
 * - `rejected`: 401 or 403, the credentials are wrong.
 * - `refused`: any other 4xx, the endpoint answered but refused the request (wrong base URL or
 *   model, assumed).
 * - `unreachable`: network, timeout, 408, 429 or 5xx; retrying later may work.
 */
export type ProbeVerdict = "verified" | "rejected" | "refused" | "unreachable";

export function classifyProbe(outcome: LlmProbeOutcome): ProbeVerdict {
  if (outcome.kind === "ok") return "verified";
  const { status } = outcome;
  if (status === 401 || status === 403) return "rejected";
  if (status === undefined || status >= 500 || status === 408 || status === 429) {
    return "unreachable";
  }
  return status >= 400 ? "refused" : "unreachable";
}

/** The three LLM secrets, as the store names them. */
export type LlmSecretStates = {
  anthropic_api_key: SecretReadState;
  anthropic_auth_token: SecretReadState;
  /** Obsolete storage state; ignored during provider selection. */
  openai_api_key?: SecretReadState;
};

export type LlmSelectionState =
  | { provider: "anthropic" }
  | { provider: null; reason: "not_configured" | "needs_reset" };

/**
 * FR-LLMCFG-01: only Anthropic is supported; obsolete OpenAI records are ignored.
 * An undecryptable Anthropic secret is `needs_reset`.
 */
export function selectLlmProvider(states: LlmSecretStates): LlmSelectionState {
  const anthropic = [states.anthropic_api_key, states.anthropic_auth_token];
  if (anthropic.some((s) => s !== "not_configured")) {
    return anthropic.includes("needs_reset")
      ? { provider: null, reason: "needs_reset" }
      : { provider: "anthropic" };
  }
  return { provider: null, reason: "not_configured" };
}

/** Stored Anthropic values (`setting_value`), structurally `SettingValues` (no port import). */
export type AnthropicStoredValues = {
  anthropic_base_url?: string;
  anthropic_model?: string;
  anthropic_auth_header?: string;
  anthropic_server_fallback?: boolean;
};

export type AnthropicRuntime = {
  baseUrl: string | null;
  model: string;
};

/** Re-checks stored values with the save rules and fills the defaults. Fails closed. */
export function readAnthropicStored(values: AnthropicStoredValues): Result<AnthropicRuntime> {
  const baseUrl = parseLlmBaseUrl(values.anthropic_base_url, "baseUrl");
  if (!baseUrl.ok) return baseUrl;
  const model = parseLlmModel(values.anthropic_model, "model");
  if (!model.ok) return model;
  return ok({
    baseUrl: baseUrl.value,
    model: model.value ?? DEFAULT_ANTHROPIC_MODEL,
  });
}

/**
 * One fully resolved provider: what an adapter is built from, both at runtime (from the store)
 * and for the connection test (from the submitted form). Holds a credential: never log or return it.
 */
export type AnthropicTarget = AnthropicRuntime & {
  provider: "anthropic";
  credential: { kind: AnthropicCredentialType; value: string };
};
export type LlmTarget = AnthropicTarget;

/** What the browser may see about one LLM secret. Never the value. Dates are ISO strings. */
export type LlmCredentialView =
  | { state: "unset" }
  | {
      state: "set" | "needs_reset";
      last4: string;
      savedAt: string;
      /** Null: saved but not verified (⚠ 未验证). */
      verifiedAt: string | null;
      /** From the last probe. */
      model?: string;
      latencyMs?: number;
    };

/** Explicit pick: the value, the saver and any other test fact never reach the client. */
export function toLlmCredentialView(read: SecretReadLike): LlmCredentialView {
  if (read.state === "not_configured") return { state: "unset" };
  const { meta } = read;
  const model = meta.testResult?.["model"];
  const latencyMs = meta.testResult?.["latencyMs"];
  return {
    state: read.state === "ready" ? "set" : "needs_reset",
    last4: meta.last4,
    savedAt: meta.savedAt.toISOString(),
    verifiedAt: meta.verifiedAt ? meta.verifiedAt.toISOString() : null,
    ...(typeof model === "string" && model !== "" ? { model } : {}),
    ...(typeof latencyMs === "number" && Number.isFinite(latencyMs) ? { latencyMs } : {}),
  };
}
