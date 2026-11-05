import { rateLimiterContract } from "../../testing/contracts/rate-limiter.contract";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { useRedisTestEnv } from "../../testing/integration/redis-harness";
import { CryptoIdGenerator } from "../system/crypto-id-generator";
import { RedisRateLimiter } from "./redis-rate-limiter";

const env = useRedisTestEnv(import.meta.filename);

// `now` comes from a FakeClock, so the window is exercised without sleeping. Each key is also
// given a PEXPIRE of window + padding in real time, which outlives the (fast) test.
rateLimiterContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new RedisRateLimiter(env.fresh(), clock, new CryptoIdGenerator()),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
