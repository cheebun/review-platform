import type { AttemptLimiter } from "../../ports/attempt-limiter";
import { attemptLimiterContract } from "../../testing/contracts/attempt-limiter.contract";
import {
  realTimeHarness,
  TIME_SCALE,
  useRedisTestEnv,
} from "../../testing/integration/redis-harness";
import { RedisAttemptLimiter } from "./redis-attempt-limiter";

const env = useRedisTestEnv(import.meta.filename);

/** Scales the policy up and the reported wait back down (see `TIME_SCALE`). */
function scaled(limiter: AttemptLimiter): AttemptLimiter {
  return {
    attempt: async (key, p) => {
      const r = await limiter.attempt(key, {
        limit: p.limit,
        windowMs: p.windowMs * TIME_SCALE,
        lockoutMs: p.lockoutMs * TIME_SCALE,
      });
      return { allowed: r.allowed, retryAfterMs: Math.ceil(r.retryAfterMs / TIME_SCALE) };
    },
    reset: (key) => limiter.reset(key),
  };
}

attemptLimiterContract(() => realTimeHarness(scaled(new RedisAttemptLimiter(env.fresh()))));
