import { validateLoginTokenInput } from "../../domain/identity/login-token";
import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { AttemptLimiter, AttemptPolicy } from "../../ports/attempt-limiter";
import type { AuthPort } from "../../ports/auth";
import type { LoginTokenHasher } from "../../ports/login-token-hasher";
import { LOGIN_TOKEN_NOT_FOUND, type LoginTokenStore } from "../../ports/login-token-store";
import type { Logger } from "../../ports/system";

/**
 * Login with the single user-chosen token (FR-AUTH-01, -02, -07). The token is never logged and
 * never stored: only its hash reaches the store.
 */

export type LoginTokenDeps = {
  auth: AuthPort;
  loginTokens: LoginTokenStore;
  attemptLimiter: AttemptLimiter;
  loginTokenHasher: LoginTokenHasher;
  logger: Logger;
};

/** 5 failures per client IP within 15 minutes lock that IP out for 15 minutes. */
export const LOGIN_ATTEMPT_POLICY: AttemptPolicy = {
  limit: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
};

/** Login and rotation share one counter per IP. Callers without a known IP share one bucket. */
export function loginAttemptKey(ip: string | undefined): string {
  return `login:${ip || "unknown"}`;
}

const UNAUTHENTICATED: DomainError = { kind: "unauthenticated" };

const confirmMismatch = (): { ok: false; error: DomainError } =>
  err({ kind: "validation", field: "confirm", message: "Tokens do not match." });

/** Validates a new token and its confirmation. */
function validateNewToken(token: unknown, confirm: unknown): Result<string> {
  const valid = validateLoginTokenInput(token);
  if (!valid.ok) return valid;
  return confirm === valid.value ? valid : confirmMismatch();
}

/**
 * Counts one attempt for `ip` and checks `token` against the stored hash. Reserve-then-verify:
 * the attempt is counted before the slow hash check, so concurrent guesses cannot outrun the
 * limit. A success resets the counter.
 */
async function checkToken(
  deps: LoginTokenDeps,
  hash: string,
  token: unknown,
  ip: string | undefined,
): Promise<Result<void>> {
  const key = loginAttemptKey(ip);
  const attempt = await deps.attemptLimiter.attempt(key, LOGIN_ATTEMPT_POLICY);
  if (!attempt.allowed) {
    deps.logger.warn("login rate limited", { ip, retryAfterMs: attempt.retryAfterMs });
    return err({ kind: "rate_limited", retryAfterMs: attempt.retryAfterMs });
  }
  // A malformed token is just a wrong token: no hint about the rules at login.
  const matches =
    validateLoginTokenInput(token).ok &&
    (await deps.loginTokenHasher.verify(token as string, hash));
  if (!matches) {
    deps.logger.warn("login token rejected", { ip });
    return err(UNAUTHENTICATED);
  }
  await deps.attemptLimiter.reset(key);
  return ok(undefined);
}

export async function getSetupStatus(deps: Pick<LoginTokenDeps, "loginTokens">) {
  return { initialized: await deps.loginTokens.isInitialized() };
}

/**
 * `not_found login_token` before setup (the client goes to /setup), `rate_limited` over the
 * limit, `unauthenticated` for a wrong token, otherwise signs the owner in.
 */
export async function loginWithToken(
  deps: LoginTokenDeps,
  input: { token: unknown; ip: string | undefined },
  headers: Headers,
): Promise<Result<void>> {
  const hash = await deps.loginTokens.getHash();
  if (hash === null) return err(LOGIN_TOKEN_NOT_FOUND);
  const checked = await checkToken(deps, hash, input.token, input.ip);
  if (!checked.ok) return checked;
  await deps.auth.signInOwner(headers);
  deps.logger.info("login succeeded", { ip: input.ip });
  return ok(undefined);
}

/**
 * Replaces the token and revokes every session in one transaction, then clears the caller's
 * cookie. A wrong current token is `validation` on `current` and counts toward the login limit.
 */
export async function rotateLoginToken(
  deps: LoginTokenDeps,
  actor: Actor,
  input: { current: unknown; token: unknown; confirm: unknown; ip: string | undefined },
  headers: Headers,
): Promise<Result<void>> {
  if (actor.kind !== "user") return err({ kind: "forbidden", reason: "user session required" });
  const token = validateNewToken(input.token, input.confirm);
  if (!token.ok) return token;
  const hash = await deps.loginTokens.getHash();
  if (hash === null) return err(LOGIN_TOKEN_NOT_FOUND);
  const checked = await checkToken(deps, hash, input.current, input.ip);
  if (!checked.ok) {
    return checked.error.kind === "unauthenticated"
      ? err({ kind: "validation", field: "current", message: "Current token is incorrect." })
      : checked;
  }
  const rotated = await deps.auth.rotateLoginToken(await deps.loginTokenHasher.hash(token.value));
  if (!rotated.ok) return rotated;
  await deps.auth.clearSessionCookie(headers);
  deps.logger.info("login token rotated; all sessions revoked", { userId: actor.userId });
  return ok(undefined);
}
