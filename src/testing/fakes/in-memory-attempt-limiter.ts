import type { AttemptLimiter, AttemptPolicy, AttemptResult } from "../../ports/attempt-limiter";
import type { Clock } from "../../ports/system";

/** Same rules as the Redis script: a counter with one expiry, extended to the lockout. */
export class InMemoryAttemptLimiter implements AttemptLimiter {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly clock: Clock) {}

  async attempt(key: string, policy: AttemptPolicy): Promise<AttemptResult> {
    const now = this.clock.now().getTime();
    let entry = this.entries.get(key);
    if (entry && entry.expiresAt <= now) entry = undefined;
    if (entry && entry.count >= policy.limit) {
      return { allowed: false, retryAfterMs: Math.max(1, entry.expiresAt - now) };
    }
    const count = (entry?.count ?? 0) + 1;
    const expiresAt =
      count >= policy.limit ? now + policy.lockoutMs : (entry?.expiresAt ?? now + policy.windowMs);
    this.entries.set(key, { count, expiresAt });
    return { allowed: true, retryAfterMs: 0 };
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }
}
