import type { RateLimiter, RateLimitResult } from "../../ports/rate-limiter";
import type { Clock } from "../../ports/system";

export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {}

  async hit(key: string, opts: { limit: number; windowMs: number }): Promise<RateLimitResult> {
    const now = this.clock.now().getTime();
    const live = (this.hits.get(key) ?? []).filter((at) => at > now - opts.windowMs);
    if (live.length >= opts.limit) {
      this.hits.set(key, live);
      const oldest = live[live.length - opts.limit]!;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + opts.windowMs - now),
      };
    }
    live.push(now);
    this.hits.set(key, live);
    return { allowed: true, remaining: opts.limit - live.length, retryAfterMs: 0 };
  }
}
