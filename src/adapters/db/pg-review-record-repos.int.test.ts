import {
  CONTRACT_REACTION_RETRY,
  reactionOutboxContract,
} from "../../testing/contracts/reaction-outbox.contract";
import { reviewRecordRepoContract } from "../../testing/contracts/review-record-repo.contract";
import { threadReviewIndexContract } from "../../testing/contracts/thread-review-index.contract";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { pgSchemaFixture } from "../../testing/integration/pg-fixture";
import { PgReactionOutbox } from "./pg-reaction-outbox";
import { PgReviewRecordRepo } from "./pg-review-record-repo";
import { PgThreadReviewIndex } from "./pg-thread-review-index";

// Remote PostgreSQL with a real pool: the concurrent cases (idempotent inserts, gap-free seqs,
// SKIP LOCKED claims, per-message enqueue lock) reach the server in parallel here.
const fixture = pgSchemaFixture(import.meta.url);

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
