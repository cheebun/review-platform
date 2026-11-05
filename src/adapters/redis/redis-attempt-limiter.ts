import type { AttemptLimiter, AttemptPolicy, AttemptResult } from "../../ports/attempt-limiter";
import type { Redis } from "./client";
import { assertPositiveInt } from "./validate";

/** A counter key per caller key, with one TTL: the window, extended to the lockout at `limit`. */
export class RedisAttemptLimiter implements AttemptLimiter {
  constructor(private readonly redis: Redis) {}

  async attempt(key: string, policy: AttemptPolicy): Promise<AttemptResult> {
    assertPositiveInt("limit", policy.limit);
    assertPositiveInt("windowMs", policy.windowMs);
    assertPositiveInt("lockoutMs", policy.lockoutMs);
    const reply = await this.redis.exec((c) =>
      c.attemptLimit(this.counterKey(key), policy.limit, policy.windowMs, policy.lockoutMs),
    );
    const [allowed, retryAfterMs] = reply as unknown as [number, number];
    return { allowed: allowed === 1, retryAfterMs };
  }

  async reset(key: string): Promise<void> {
    await this.redis.exec((c) => c.del(this.counterKey(key)));
  }

  private counterKey(key: string): string {
    return this.redis.key(`attempts:${key}`);
  }
}
