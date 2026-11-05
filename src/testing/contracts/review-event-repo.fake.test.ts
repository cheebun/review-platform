import { reviewEventRepoContract } from "./review-event-repo.contract";
import { InMemoryReviewEventRepo } from "../fakes/in-memory-review-event-repo";

reviewEventRepoContract(async () => ({
  impl: new InMemoryReviewEventRepo(),
  advance: async () => {},
  cleanup: async () => {},
}));
