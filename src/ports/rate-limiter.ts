export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterMs: number };

export interface RateLimiter {
  /** Sliding window: at most `limit` allowed hits in any `windowMs`. Blocked hits are not counted. */
  hit(key: string, opts: { limit: number; windowMs: number }): Promise<RateLimitResult>;
}
