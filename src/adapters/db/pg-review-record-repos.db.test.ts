import {
  CONTRACT_REACTION_RETRY,
  reactionOutboxContract,
} from "../../testing/contracts/reaction-outbox.contract";
import { reviewRecordRepoContract } from "../../testing/contracts/review-record-repo.contract";
import { threadReviewIndexContract } from "../../testing/contracts/thread-review-index.contract";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { pgliteFixture } from "./pglite-fixture";
import { PgReactionOutbox } from "./pg-reaction-outbox";
import { PgReviewRecordRepo } from "./pg-review-record-repo";
import { PgThreadReviewIndex } from "./pg-thread-review-index";

// One PGlite instance for the 3d repositories (see repos.db.test.ts for why).
const fixture = pgliteFixture();

reviewRecordRepoContract(async () => ({
  impl: new PgReviewRecordRepo(fixture.db()),
  advance: async () => {},
  cleanup: async () => {},
}));

threadReviewIndexContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new PgThreadReviewIndex(fixture.db(), clock),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});

reactionOutboxContract(async () => {
  const clock = new FakeClock();
  return {
    impl: new PgReactionOutbox(fixture.db(), clock, CONTRACT_REACTION_RETRY),
    advance: async (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});
