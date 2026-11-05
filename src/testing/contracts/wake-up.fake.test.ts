import { wakeUpContract } from "./wake-up.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryWakeUp } from "../fakes/in-memory-wake-up";

wakeUpContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryWakeUp(clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
