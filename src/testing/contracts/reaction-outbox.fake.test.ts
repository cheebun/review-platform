import { CONTRACT_REACTION_RETRY, reactionOutboxContract } from "./reaction-outbox.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryReactionOutbox } from "../fakes/in-memory-reaction-outbox";

reactionOutboxContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryReactionOutbox(clock, CONTRACT_REACTION_RETRY),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
