import type { DomainError } from "../../domain/shared/result";

// @slack/web-api `ErrorCode` values. Matched by `error.code`, never by message text.
const PLATFORM = "slack_webapi_platform_error";
const REQUEST = "slack_webapi_request_error";
const HTTP = "slack_webapi_http_error";
const RATE_LIMITED = "slack_webapi_rate_limited_error";

const FORBIDDEN = new Set([
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "not_allowed_token_type",
  "access_denied",
  "no_permission",
  "not_in_channel",
]);
const NOT_FOUND = new Set(["channel_not_found", "user_not_found", "message_not_found"]);
const RETRYABLE = new Set([
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  "team_added_to_org",
]);
/** Platform-level `ratelimited` has no machine-readable wait, so assume the common minimum. */
const DEFAULT_RETRY_AFTER_MS = 1000;

const upstream = (retryable: boolean): DomainError => ({
  kind: "upstream",
  service: "slack",
  retryable,
});

function headerSeconds(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "retry-after") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}

/** Maps a thrown `@slack/web-api` error. The SDK message is never copied into the result. */
export function mapSlackError(error: unknown): DomainError {
  if (!error || typeof error !== "object") return upstream(false);
  const e = error as {
    code?: unknown;
    data?: { error?: unknown };
    retryAfter?: unknown;
    statusCode?: unknown;
    headers?: unknown;
  };
  switch (e.code) {
    case PLATFORM: {
      const code = typeof e.data?.error === "string" ? e.data.error : "";
      if (FORBIDDEN.has(code)) return { kind: "forbidden", reason: `slack_${code}` };
      if (NOT_FOUND.has(code)) return { kind: "not_found", entity: "slack" };
      if (code === "ratelimited")
        return { kind: "rate_limited", retryAfterMs: DEFAULT_RETRY_AFTER_MS };
      return upstream(RETRYABLE.has(code));
    }
    case RATE_LIMITED: {
      const s = typeof e.retryAfter === "number" ? e.retryAfter : 1;
      return { kind: "rate_limited", retryAfterMs: Math.max(0, s) * 1000 };
    }
    case HTTP: {
      const status = typeof e.statusCode === "number" ? e.statusCode : 0;
      if (status === 429)
        return {
          kind: "rate_limited",
          retryAfterMs: (headerSeconds(e.headers) ?? 1) * 1000,
        };
      if (status === 401 || status === 403) return { kind: "forbidden", reason: "slack_http" };
      return upstream(status >= 500);
    }
    case REQUEST:
      return upstream(true); // network failure or timeout
    default:
      return upstream(false);
  }
}
