import type Anthropic from "@anthropic-ai/sdk";
import type { ClientOptions } from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from "../../domain/settings/llm-settings";
import type { Logger } from "../../ports/system";

export { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL };

/** Anthropic `output_config.effort`. */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Used when no base URL is configured. Always passed to the SDK explicitly: given `undefined`,
 * the SDK would read `ANTHROPIC_BASE_URL` from `process.env`, and adapters never read the
 * environment (architecture §6).
 */
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** As `DEFAULT_ANTHROPIC_BASE_URL`: always passed, so the SDK never reads `OPENAI_BASE_URL`. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Streaming keeps long outputs from hitting HTTP timeouts, so a high ceiling is safe. */
export const DEFAULT_MAX_TOKENS = 64_000;
export const OPENAI_MAX_OUTPUT_TOKENS = 32_000;
/**
 * Anthropic connection and request settings. Adapters never read `process.env`: the composition
 * root resolves configuration and passes it here.
 */
export interface AnthropicAdapterOptions {
  /** Bearer-token (gateway) credential. Wins over `apiKey` when both are set, as before. */
  authToken?: string;
  apiKey?: string;
  baseURL?: string;
  /** Falls back to `DEFAULT_ANTHROPIC_MODEL` when absent or blank. */
  model?: string;
  /** `output_config.effort`. Each adapter has its own default. */
  effort?: AnthropicEffort;
  /** Per-request timeout in ms. Absent keeps the SDK default. */
  timeoutMs?: number;
  /** Absent keeps the SDK default (2). */
  maxRetries?: number;
  maxTokens?: number;
  /** Builds the SDK client. Defaults to `new Anthropic(options)`. Lets tests observe the options. */
  clientFactory?: (options: ClientOptions) => Anthropic;
  logger?: Logger;
}

export interface OpenAiAdapterOptions {
  apiKey: string;
  /** Relay or proxy, e.g. `https://relay.example.com/v1`. Must support the Responses API. */
  baseURL?: string;
  model?: string;
  reasoningEffort?: OpenAI.ReasoningEffort;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  logger?: Logger;
}

/**
 * Per-call options of every LLM adapter method (the port's type). `signal` is handed to the SDK:
 * aborting it ends the in-flight request (and any retry) at once, and the call resolves to a
 * non-retryable `upstream` error. An already aborted signal sends nothing.
 */
export type { LlmCallOptions } from "../../ports/llm-call";
