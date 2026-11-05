/**
 * Per-call options of every LLM port method. `signal` ends the in-flight request (and any retry)
 * at once; the call then resolves to a non-retryable `upstream` error. An already aborted signal
 * sends nothing. Structurally the adapters' `LlmCallOptions` (`adapters/llm/options.ts`).
 */
export interface LlmCallOptions {
  signal?: AbortSignal;
}
