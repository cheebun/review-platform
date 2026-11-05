export type AttemptPolicy = {
  /** Attempts allowed per window; reserving the last one starts the lockout. */
  limit: number;
  /** The window starts at the first attempt after a reset or an expiry. */
  windowMs: number;
  /** How long every attempt is refused once `limit` attempts were reserved. */
  lockoutMs: number;
};

export type AttemptResult = { allowed: boolean; retryAfterMs: number };

/**
 * Counts failed credential attempts per key (for example per client IP) and locks the key out.
 *
 * Reserve-then-verify: `attempt` is called BEFORE the credential is checked and counts as a failure
 * until `reset` (a success) forgets it. That keeps concurrent guesses honest: of any number of
 * parallel attempts, at most `limit` are allowed in total.
 */
export interface AttemptLimiter {
  /**
   * Reserves one attempt. Allowed while fewer than `limit` were reserved in the current window.
   * Reserving the `limit`-th allows it and starts a lockout of `lockoutMs`. While the lockout
   * lasts, attempts are refused with the remaining time and are not counted (they never extend
   * the lockout).
   */
  attempt(key: string, policy: AttemptPolicy): Promise<AttemptResult>;
  /** Forgets every attempt for `key`, ending a lockout too. */
  reset(key: string): Promise<void>;
}
