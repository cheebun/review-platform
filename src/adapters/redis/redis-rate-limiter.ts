import type { RateLimiter, RateLimitResult } from "../../ports/rate-limiter";
import type { Clock, IdGenerator } from "../../ports/system";
import type { Redis } from "./client";
import { assertPositiveInt } from "./validate";

export interface RedisRateLimiterOptions {
  /** Extra key lifetime beyond the window, so clock skew cannot drop live hits. Default 1000 ms. */
  ttlPaddingMs?: number;
}

export class RedisRateLimiter implements RateLimiter {
  private readonly ttlPaddingMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: RedisRateLimiterOptions = {},
  ) {
    this.ttlPaddingMs = options.ttlPaddingMs ?? 1_000;
  }

  async hit(key: string, opts: { limit: number; windowMs: number }): Promise<RateLimitResult> {
    assertPositiveInt("limit", opts.limit);
    assertPositiveInt("windowMs", opts.windowMs);
    const now = this.clock.now().getTime();
    // Unique member so hits in the same millisecond do not collapse into one sorted-set entry.
    const member = `${now}-${this.ids.uuid()}`;
    const reply = await this.redis.exec((c) =>
      c.rateLimit(
        this.redis.key(`rl:${key}`),
        now,
        opts.windowMs,
        opts.limit,
        member,
        opts.windowMs + this.ttlPaddingMs,
      ),
    );
    const [allowed, remaining, retryAfterMs] = reply as unknown as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}
