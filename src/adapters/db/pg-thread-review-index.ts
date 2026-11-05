import { and, eq } from "drizzle-orm";
import { err, ok, type Result } from "../../domain/shared/result";
import type { Clock } from "../../ports/system";
import {
  SLACK_TS,
  unionPrUrls,
  validateRecordThreadReview,
  validateThreadKey,
  type RecordThreadReview,
  type ThreadKey,
  type ThreadReview,
  type ThreadReviewIndex,
} from "../../ports/thread-review-index";
import type { Db } from "./client";
import { slackReviewThread } from "./pg-thread-review-index-schema";

type Row = typeof slackReviewThread.$inferSelect;
type Tx = Pick<Db, "select" | "insert" | "update">;

const toThread = (r: Row): ThreadReview => ({
  channel: r.channel,
  threadTs: r.threadTs,
  prUrls: r.prUrls,
  requesterSlackId: r.requesterSlackId,
  latestReviewId: r.latestReviewId,
  reviewSeq: r.reviewSeq,
  statusMessageTs: r.statusMessageTs,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const byKey = (k: ThreadKey) =>
  and(eq(slackReviewThread.channel, k.channel), eq(slackReviewThread.threadTs, k.threadTs));

/**
 * The upsert, for a caller's own transaction. The first INSERT wins a race to create the
 * thread; every other caller then takes the row lock, so `reviewSeq` increments without gaps.
 */
export async function recordThreadReview(
  tx: Tx,
  input: RecordThreadReview,
  now: Date,
): Promise<Result<ThreadReview>> {
  const valid = validateRecordThreadReview(input);
  if (!valid.ok) return valid;
  const [created] = await tx
    .insert(slackReviewThread)
    .values({
      channel: input.channel,
      threadTs: input.threadTs,
      prUrls: unionPrUrls([], input.prUrls),
      requesterSlackId: input.requesterSlackId,
      latestReviewId: input.reviewId,
      reviewSeq: 1,
      statusMessageTs: input.statusMessageTs ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return ok(toThread(created));
  const [prev] = await tx.select().from(slackReviewThread).where(byKey(input)).for("update");
  if (!prev) throw new Error("slack_review_thread row vanished during upsert");
  const [row] = await tx
    .update(slackReviewThread)
    .set({
      prUrls: unionPrUrls(prev.prUrls, input.prUrls),
      latestReviewId: input.reviewId,
      reviewSeq: prev.reviewSeq + 1,
      statusMessageTs: input.statusMessageTs ?? prev.statusMessageTs,
      updatedAt: now,
    })
    .where(byKey(input))
    .returning();
  return ok(toThread(row!));
}

export class PgThreadReviewIndex implements ThreadReviewIndex {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async recordReview(input: RecordThreadReview): Promise<Result<ThreadReview>> {
    const valid = validateRecordThreadReview(input);
    if (!valid.ok) return valid;
    const now = this.clock.now();
    return this.db.transaction((tx) => recordThreadReview(tx as unknown as Tx, input, now));
  }

  async setStatusMessage(key: ThreadKey, statusMessageTs: string): Promise<Result<ThreadReview>> {
    const valid = validateThreadKey(key);
    if (!valid.ok) return valid;
    if (typeof statusMessageTs !== "string" || !SLACK_TS.test(statusMessageTs))
      return err({ kind: "validation", field: "statusMessageTs", message: "invalid Slack ts" });
    const [row] = await this.db
      .update(slackReviewThread)
      .set({ statusMessageTs, updatedAt: this.clock.now() })
      .where(byKey(valid.value))
      .returning();
    return row ? ok(toThread(row)) : err({ kind: "not_found", entity: "slack_review_thread" });
  }

  async get(key: ThreadKey): Promise<ThreadReview | null> {
    const valid = validateThreadKey(key);
    if (!valid.ok) return null;
    const [row] = await this.db.select().from(slackReviewThread).where(byKey(valid.value));
    return row ? toThread(row) : null;
  }
}
