import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type {
  NewReviewEvent,
  ReviewEventRecord,
  ReviewEventFilter,
  ReviewEventRepo,
} from "../../ports/review-event-repo";
import type { Db } from "./client";
import { reviewEvent } from "./schema";

type Row = typeof reviewEvent.$inferSelect;

function toRecord(row: Row): ReviewEventRecord {
  const out: ReviewEventRecord = {
    id: row.id,
    type: row.type,
    actor: { kind: row.actorKind, id: row.actorId },
    at: row.at,
  };
  if (row.prUrl !== null) out.prUrl = row.prUrl;
  if (row.reviewId !== null) out.reviewId = row.reviewId;
  if (row.jobId !== null) out.jobId = row.jobId;
  if (row.sha !== null) out.sha = row.sha;
  if (row.reason !== null) out.reason = row.reason;
  if (row.source !== null) out.source = row.source;
  if (row.detail !== null) out.detail = row.detail;
  return out;
}

/**
 * Inserts one event with `db`, which may be a transaction: the settings adapters call this inside
 * their own transaction so a change and its event commit or roll back together.
 */
export async function insertReviewEvent(
  db: Pick<Db, "insert">,
  event: NewReviewEvent,
): Promise<{ inserted: boolean }> {
  const rows = await db
    .insert(reviewEvent)
    .values({
      id: event.id,
      type: event.type,
      actorKind: event.actor.kind,
      actorId: event.actor.id,
      prUrl: event.prUrl ?? null,
      reviewId: event.reviewId ?? null,
      jobId: event.jobId ?? null,
      sha: event.sha ?? null,
      reason: event.reason ?? null,
      source: event.source ?? null,
      detail: event.detail ?? null,
      at: event.at,
    })
    // The (job, url, step) unique index makes a repeated step a no-op.
    .onConflictDoNothing()
    .returning({ id: reviewEvent.id });
  return { inserted: rows.length > 0 };
}

/** `review_event`: insert and select only (the table rejects UPDATE and DELETE). */
export class PgReviewEventRepo implements ReviewEventRepo {
  constructor(private readonly db: Db) {}

  async append(event: NewReviewEvent): Promise<{ inserted: boolean }> {
    return insertReviewEvent(this.db, event);
  }

  async list(filter: ReviewEventFilter): Promise<ReviewEventRecord[]> {
    if (filter.types && filter.types.length === 0) return [];
    const limit = Math.max(0, Math.min(Math.trunc(filter.limit), 500));
    const where: SQL[] = [];
    if (filter.types) where.push(inArray(reviewEvent.type, [...filter.types]));
    if (filter.prUrl !== undefined) where.push(eq(reviewEvent.prUrl, filter.prUrl));
    if (filter.reviewId !== undefined) where.push(eq(reviewEvent.reviewId, filter.reviewId));
    const rows = await this.db
      .select()
      .from(reviewEvent)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(reviewEvent.at), desc(reviewEvent.id))
      .limit(limit);
    return rows.map(toRecord);
  }
}
