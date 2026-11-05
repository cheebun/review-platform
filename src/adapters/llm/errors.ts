import * as Anthropic from "@anthropic-ai/sdk";
import type { DomainError } from "../../domain/shared/result";
import type { Logger } from "../../ports/system";

const upstream = (retryable: boolean): DomainError => ({
  kind: "upstream",
  service: "llm",
  retryable,
});

/** Legacy adapters pass their SDK explicitly; the active path imports only Anthropic. */
type LlmSdk = typeof Anthropic | typeof import("openai") | typeof import("openai").default;

type Ctor = abstract new (...args: never[]) => unknown;
const isAny = (error: unknown, ...classes: Ctor[]) =>
  classes.some((cls) => error instanceof (cls as unknown as new () => unknown));

/** Any status from either SDK. `undefined` for connection errors and in-stream error events. */
const statusOf = (error: unknown, sdk: LlmSdk): number | undefined | null =>
  error instanceof sdk.APIError ? error.status : null;

/**
 * Maps a thrown SDK error to a `DomainError`, from the most specific typed class to the least.
 * Never matches on message text. Logs the class, status and request id only, because the message
 * can echo request content or credentials (S4).
 */
export function mapLlmError(error: unknown, logger?: Logger, sdk: LlmSdk = Anthropic): DomainError {
  const mapped = classify(error, sdk);
  logger?.warn("llm request failed", {
    errorClass: error instanceof Error ? error.constructor.name : typeof error,
    status: statusOf(error, sdk) ?? undefined,
    requestId: error instanceof sdk.APIError ? (error.requestID ?? undefined) : undefined,
    retryable: mapped.kind === "upstream" ? mapped.retryable : undefined,
  });
  return mapped;
}

function classify(error: unknown, sdk: LlmSdk): DomainError {
  // A caller-initiated abort is a decision, not an outage.
  if (isAny(error, sdk.APIUserAbortError)) return upstream(false);
  // Timeouts extend connection errors.
  if (isAny(error, sdk.APIConnectionError)) return upstream(true);
  if (isAny(error, sdk.RateLimitError)) return upstream(true);
  if (isAny(error, sdk.InternalServerError)) {
    return upstream(true);
  }
  if (isAny(error, sdk.ConflictError)) return upstream(true);
  if (
    isAny(
      error,
      sdk.BadRequestError,
      sdk.AuthenticationError,
      sdk.PermissionDeniedError,
      sdk.NotFoundError,
      sdk.UnprocessableEntityError,
    )
  ) {
    return upstream(false);
  }
  const status = statusOf(error, sdk);
  // No status: an error event arrived mid-stream (for example `overloaded_error`). Transient.
  if (status === undefined) return upstream(true);
  if (typeof status === "number") return upstream(status >= 500 || status === 408);
  return upstream(false);
}
