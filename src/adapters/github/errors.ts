import { err, type DomainError } from "../../domain/shared/result";
import { PrChangedError } from "./diff-recovery";

const DEFAULT_RETRY_AFTER_MS = 60_000;

export type ErrorContext = {
  /** Entity named in `not_found`. */
  entity: string;
  /** Merge calls map 405/409/422 to `conflict`. */
  merge?: boolean;
  now: () => number;
};

const MAX_REASON_CHARS = 200;

/** A GitHub response that does not have the shape the adapter relies on. Never retried. */
export class GitHubSchemaError extends Error {
  constructor(what: string) {
    super(`unexpected GitHub response shape: ${what}`);
    this.name = "GitHubSchemaError";
  }
}

type HeaderBag = Record<string, string | number | undefined>;

type RequestErrorLike = { status: number; headers: HeaderBag; bodyMessage: string | null };

/**
 * Structural match for Octokit's RequestError (name "HttpError"). The mapping is decided by
 * status and headers only; the response body's `message` is kept solely as a merge reason.
 */
function asRequestError(e: unknown): RequestErrorLike | null {
  if (typeof e !== "object" || e === null) return null;
  const candidate = e as {
    name?: unknown;
    status?: unknown;
    response?: { headers?: HeaderBag; data?: unknown };
  };
  if (candidate.name !== "HttpError" || typeof candidate.status !== "number") return null;
  const data = candidate.response?.data;
  const message =
    typeof data === "object" && data !== null ? (data as { message?: unknown }).message : null;
  return {
    status: candidate.status,
    headers: candidate.response?.headers ?? {},
    bodyMessage: typeof message === "string" ? message : null,
  };
}

/** Untrusted text from GitHub: control characters removed, whitespace collapsed, bounded. */
export function sanitizeReason(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON_CHARS);
}

function rateLimitRetryMs(headers: HeaderBag, now: number): number | null {
  const retryAfter = headers["retry-after"];
  const remaining = headers["x-ratelimit-remaining"];
  if (retryAfter == null && String(remaining) !== "0") return null;
  const seconds = retryAfter == null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - now);
  return DEFAULT_RETRY_AFTER_MS;
}

const upstream = (retryable: boolean): DomainError => ({
  kind: "upstream",
  service: "github",
  retryable,
});

/** Maps anything thrown while talking to GitHub onto a DomainError. */
export function toDomainError(error: unknown, ctx: ErrorContext): DomainError {
  if (error instanceof PrChangedError) {
    return { kind: "conflict", reason: "pull request changed while its diff was being read" };
  }

  if (error instanceof GitHubSchemaError) return upstream(false);

  const http = asRequestError(error);
  if (http) {
    const { status, headers } = http;
    if (status === 403 || status === 429) {
      const retryAfterMs = rateLimitRetryMs(headers, ctx.now());
      if (retryAfterMs != null) return { kind: "rate_limited", retryAfterMs };
      if (status === 429) return { kind: "rate_limited", retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }
    if (status === 401 || status === 403) {
      return { kind: "forbidden", reason: "GitHub rejected the credentials or permissions" };
    }
    if (status === 404) return { kind: "not_found", entity: ctx.entity };
    if (ctx.merge && (status === 405 || status === 409 || status === 422)) {
      const detail = sanitizeReason(http.bodyMessage ?? "");
      return {
        kind: "conflict",
        reason: `GitHub ${status}: ${detail || "pull request cannot be merged at this commit"}`,
      };
    }
    if (status === 422) {
      return { kind: "validation", message: "GitHub rejected the request as invalid" };
    }
    if (status >= 500 || status === 408) return upstream(true);
    return upstream(false);
  }

  // GraphQL errors arrive as HTTP 200 with a typed `errors` array.
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "GraphqlResponseError"
  ) {
    const types = ((error as { errors?: { type?: string }[] }).errors ?? []).map((e) => e.type);
    if (types.includes("RATE_LIMITED")) {
      return { kind: "rate_limited", retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }
    if (types.includes("NOT_FOUND")) return { kind: "not_found", entity: ctx.entity };
    if (types.includes("FORBIDDEN")) {
      return { kind: "forbidden", reason: "GitHub rejected the credentials or permissions" };
    }
    return upstream(false);
  }

  // Network failures, timeouts and anything unexpected.
  return upstream(true);
}

export const failure = (error: unknown, ctx: ErrorContext) => err(toDomainError(error, ctx));
