import { throttleContract } from "./throttle.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryThrottle } from "../fakes/in-memory-throttle";

throttleContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryThrottle(clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
