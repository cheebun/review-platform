export type DomainError =
  | { kind: "validation"; field?: string; message: string }
  | { kind: "unauthenticated" }
  | { kind: "forbidden"; reason: string }
  | { kind: "not_found"; entity: string }
  | { kind: "conflict"; reason: string }
  | { kind: "deferred"; resumeToken?: string }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "upstream"; service: "github" | "slack" | "llm"; retryable: boolean }
  /** An optional feature whose configuration is absent (503). Not retryable until reconfigured. */
  | {
      kind: "not_configured";
      feature: "llm" | "slack" | "slack_events" | "github";
      /** GitHub only: a token is stored but cannot be decrypted (需要重新设置, FR-GITHUB-05). */
      reason?: "needs_reset";
    };

export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;
