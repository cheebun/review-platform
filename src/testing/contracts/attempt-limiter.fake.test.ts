import { attemptLimiterContract } from "./attempt-limiter.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryAttemptLimiter } from "../fakes/in-memory-attempt-limiter";

attemptLimiterContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryAttemptLimiter(clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
