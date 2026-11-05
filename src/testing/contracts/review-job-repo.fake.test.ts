import { FakeClock } from "../fakes/fake-clock";
import { InMemoryReviewJobRepo } from "../fakes/in-memory-review-job-repo";
import { reviewJobRepoContract } from "./review-job-repo.contract";

reviewJobRepoContract(async () => {
  const clock = new FakeClock();
  return {
    repo: new InMemoryReviewJobRepo(clock),
    advance: (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
