import { rateLimiterContract } from "./rate-limiter.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryRateLimiter } from "../fakes/in-memory-rate-limiter";

rateLimiterContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryRateLimiter(clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
