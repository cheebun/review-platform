import Anthropic, { APIError } from "@anthropic-ai/sdk";
import {
  ANTHROPIC_PROBE_MODEL,
  type LlmProbeOutcome,
  type LlmTarget,
} from "../../domain/settings/llm-settings";
import type { DomainError } from "../../domain/shared/result";
import { buildAnthropicClientOptions } from "./anthropic-structured";
import { mapLlmError } from "./errors";
import type { AnthropicAdapterOptions, LlmCallOptions } from "./options";
import {
  anthropicAdapterOptions,
  loadLlmTarget,
  type LlmAdapterExtras,
  type LlmSettingsReader,
} from "./settings-providers";

export type PingOutcome =
  | { kind: "ok"; status: number }
  | { kind: "error"; error: DomainError; status?: number };

export interface PingReport {
  provider: string;
  /** Any URL. Only its host is ever printed. */
  baseUrl?: string;
  model: string;
  authHeader: string;
  latencyMs: number;
  outcome: PingOutcome;
}

/** Host (and port) only: never credentials, path, query or fragment. */
function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "api.anthropic.com (default)";
  try {
    return new URL(baseUrl).host || "(invalid)";
  } catch {
    return "(invalid)";
  }
}

const oneLine = (value: string): string => value.replace(/[^\x20-\x7e]/g, "?");

/** Prints structured fields only, never an error message, credential or response body. */
export function formatPingReport(report: PingReport): string {
  const { outcome } = report;
  const status = outcome.kind === "ok" ? String(outcome.status) : (outcome.status ?? "none");
  const result =
    outcome.kind === "ok"
      ? "ok"
      : outcome.error.kind === "upstream"
        ? `error upstream (retryable: ${outcome.error.retryable})`
        : `error ${outcome.error.kind}`;
  return [
    `provider: ${oneLine(report.provider)}`,
    `host: ${hostOf(report.baseUrl)}`,
    `model: ${oneLine(report.model)}`,
    `auth header: ${oneLine(report.authHeader)}`,
    `status: ${status}`,
    `result: ${result}`,
    `latency: ${Math.max(0, Math.round(report.latencyMs))} ms`,
  ].join("\n");
}

export const PING_TIMEOUT_MS = 30_000;
export const PROBE_TIMEOUT_MS = 15_000;
export type PingRunOptions = LlmCallOptions & { timeoutMs?: number };

/** One bounded greeting request. Runtime model, review instructions and fallback are excluded. */
export async function runAnthropicPing(
  options: AnthropicAdapterOptions,
  run: PingRunOptions = {},
): Promise<{ outcome: PingOutcome; latencyMs: number }> {
  const started = performance.now();
  try {
    const clientOptions = buildAnthropicClientOptions({
      ...options,
      maxRetries: 0,
      timeoutMs: run.timeoutMs ?? PING_TIMEOUT_MS,
    });
    const client = options.clientFactory
      ? options.clientFactory(clientOptions)
      : new Anthropic(clientOptions);
    await client.messages.create(
      {
        model: ANTHROPIC_PROBE_MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi!" }],
        output_config: { effort: "low" },
      },
      run.signal ? { signal: run.signal } : undefined,
    );
    return { outcome: { kind: "ok", status: 200 }, latencyMs: performance.now() - started };
  } catch (error) {
    return {
      outcome: {
        kind: "error",
        error: mapLlmError(error),
        ...(error instanceof APIError && typeof error.status === "number"
          ? { status: error.status }
          : {}),
      },
      latencyMs: performance.now() - started,
    };
  }
}

/** Tests submitted settings without returning the response body or changing stored settings. */
export async function probeLlm(
  target: LlmTarget,
  run: PingRunOptions = {},
  extras: LlmAdapterExtras = {},
): Promise<LlmProbeOutcome> {
  const { outcome, latencyMs } = await runAnthropicPing(
    anthropicAdapterOptions(target, extras),
    run,
  );
  if (outcome.kind === "ok") return { kind: "ok", latencyMs, model: ANTHROPIC_PROBE_MODEL };
  return {
    kind: "error",
    latencyMs,
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
  };
}

export type SettingsPingResult =
  | { kind: "not_configured"; reason: "not_configured" | "needs_reset" }
  | { kind: "report"; report: PingReport };

/** The CLI uses the same fixed-model credential test as settings. */
export async function runLlmPingFromSettings(
  store: LlmSettingsReader,
  extras: LlmAdapterExtras = {},
): Promise<SettingsPingResult> {
  const target = await loadLlmTarget(store);
  if (!target.ok) {
    const reason =
      target.error.kind === "not_configured" && target.error.reason === "needs_reset"
        ? "needs_reset"
        : "not_configured";
    return { kind: "not_configured", reason };
  }
  const { outcome, latencyMs } = await runAnthropicPing(
    anthropicAdapterOptions(target.value, extras),
  );
  return {
    kind: "report",
    report: {
      provider: "anthropic",
      ...(target.value.baseUrl ? { baseUrl: target.value.baseUrl } : {}),
      model: ANTHROPIC_PROBE_MODEL,
      authHeader:
        target.value.credential.kind === "auth_token" ? "bearer (auth token)" : "x-api-key",
      latencyMs,
      outcome,
    },
  };
}

export const createLlmProbe =
  (extras: LlmAdapterExtras = {}, timeoutMs = PROBE_TIMEOUT_MS) =>
  (target: LlmTarget): Promise<LlmProbeOutcome> =>
    probeLlm(target, { timeoutMs }, extras);
