import { threadReviewIndexContract } from "./thread-review-index.contract";
import { FakeClock } from "../fakes/fake-clock";
import { InMemoryThreadReviewIndex } from "../fakes/in-memory-thread-review-index";

threadReviewIndexContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new InMemoryThreadReviewIndex(clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
