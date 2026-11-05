import type { DomainError } from "../domain/shared/result";

export interface HttpErrorBody {
  kind: DomainError["kind"] | "internal";
  message: string;
  requestId: string;
}

export interface HttpError {
  status: number;
  body: HttpErrorBody;
  headers?: Record<string, string>;
}

/** Fixed public messages. Never derived from the error, so internals cannot leak (S4). */
const PUBLIC_MESSAGE: Record<DomainError["kind"], string> = {
  validation: "The request is invalid.",
  unauthenticated: "Authentication is required.",
  forbidden: "You are not allowed to perform this action.",
  not_found: "The requested resource was not found.",
  conflict: "The request conflicts with the current state.",
  deferred: "The request was accepted and will continue in the background.",
  rate_limited: "Too many requests. Please retry later.",
  upstream: "An upstream service failed.",
  not_configured: "This feature is not configured on the server.",
};

function statusOf(error: DomainError): number {
  switch (error.kind) {
    case "validation":
      return 400;
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "deferred":
      return 202;
    case "rate_limited":
      return 429;
    case "upstream":
      return error.retryable ? 503 : 502;
    case "not_configured":
      return 503;
  }
}

export function toHttp(error: DomainError, requestId: string): HttpError {
  const res: HttpError = {
    status: statusOf(error),
    body: { kind: error.kind, message: PUBLIC_MESSAGE[error.kind], requestId },
  };
  if (error.kind === "rate_limited") {
    const ms = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
    res.headers = { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) };
  }
  return res;
}

/** Unexpected exceptions: the caller logs the details; the body stays generic. */
export function unexpectedToHttp(_error: unknown, requestId: string): HttpError {
  return {
    status: 500,
    body: { kind: "internal", message: "Internal server error.", requestId },
  };
}

/** Log fields for an unexpected error. Never the message of the error itself. */
export interface ErrorLogFields {
  error: string;
  causeName?: string;
  causeCode?: string;
  causeMessage?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const SAFE_CODE = /^[A-Za-z0-9_]{2,40}$/;
const MAX_CAUSE_DEPTH = 4;
const MAX_CAUSE_MESSAGE = 160;

/**
 * A Postgres message with its values removed: anything after the first colon (where Postgres puts
 * input values), single-quoted literals, `$n` placeholders, URLs and role names. Identifiers such
 * as a relation name stay, because they are what makes the log useful.
 */
function sanitizePgMessage(message: string): string {
  const head = message.split("\n", 1)[0]!.split(":", 1)[0]!;
  return head
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[URL]")
    .replace(/'[^']*'/g, "'[REDACTED]'")
    .replace(/\$\d+/g, "$?")
    .replace(/(\b(?:user|role)\s+)"[^"]*"/gi, '$1"[REDACTED]"')
    .trim()
    .slice(0, MAX_CAUSE_MESSAGE);
}

/**
 * What to log for an unexpected throw. The error's own message is never logged (a
 * DrizzleQueryError's message carries the SQL and its params, an SDK error's can carry request
 * options). From the cause chain it adds the first coded cause's name and code, and, for a
 * Postgres SQLSTATE only, its sanitized message. `detail`, `params` and `query` are never read.
 */
export function errorLogFields(error: unknown): ErrorLogFields {
  if (!(error instanceof Error)) return { error: "unknown" };
  const fields: ErrorLogFields = { error: error.name };
  let cause: unknown = error.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause instanceof Error; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_CODE.test(code)) {
      fields.causeName = cause.name;
      fields.causeCode = code;
      if (SQLSTATE.test(code)) fields.causeMessage = sanitizePgMessage(cause.message);
      return fields;
    }
    cause = cause.cause;
  }
  if (error.cause instanceof Error) fields.causeName = error.cause.name;
  return fields;
}
