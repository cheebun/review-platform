import { eventDedupeContract } from "./event-dedupe.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryEventDedupe } from "../fakes/in-memory-event-dedupe";

eventDedupeContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryEventDedupe(clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
