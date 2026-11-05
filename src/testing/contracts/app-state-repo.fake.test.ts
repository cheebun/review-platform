import { appStateRepoContract } from "./app-state-repo.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryAppStateRepo } from "../fakes/in-memory-app-state-repo";

appStateRepoContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryAppStateRepo(clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
