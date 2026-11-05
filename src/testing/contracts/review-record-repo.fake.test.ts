import { reviewRecordRepoContract } from "./review-record-repo.contract";
import { InMemoryReviewRecordRepo } from "../fakes/in-memory-review-record-repo";

reviewRecordRepoContract(async () => ({
  impl: new InMemoryReviewRecordRepo(),
  advance: async () => {},
  cleanup: async () => {},
}));
