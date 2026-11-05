/**
 * Provider-neutral scripting for the LLM msw handlers. A step says what the provider answers;
 * each transport renders it in that provider's wire format (see `anthropic.ts`, `openai.ts`).
 */
export type LlmStep =
  /** The model produced this structured value. */
  | { kind: "json"; value: unknown }
  /** The model produced this exact text (or tool-argument string), e.g. malformed JSON. */
  | { kind: "raw"; text: string }
  | { kind: "refusal"; category?: string | null; text?: string }
  /** The output was cut off at the token limit. */
  | { kind: "truncated" }
  | { kind: "http"; status: number }
  /** The connection fails before any response. */
  | { kind: "network" };

/** Parsed JSON body of a request that reached a handler. */
export type RecordedRequest = Record<string, any>;

export interface LlmTransport {
  readonly name: "anthropic" | "openai";
  readonly baseURL: string;
  readonly apiKey: string;
  /** Every request body received, in order. */
  readonly requests: RecordedRequest[];
  /** Headers of every request received (lower-case names), in order. */
  readonly headers: Record<string, string>[];
  /** Answers request N with step N. The last step repeats for any further request. */
  script(...steps: LlmStep[]): void;
}

export const OK_STEP = (value: unknown): LlmStep => ({ kind: "json", value });

/** Fast retries: the SDKs honour `retry-after-ms`, so 429/5xx tests do not sleep. */
export const FAST_RETRY_HEADERS = { "retry-after-ms": "1" };
