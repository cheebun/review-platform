import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { err, ok, type Result } from "../../domain/shared/result";
import {
  encodeReviewRecordCursor,
  validateNewReviewRecord,
  validateReviewRecordQuery,
  type NewReviewRecord,
  type ReviewRecord,
  type ReviewRecordPage,
  type ReviewRecordQuery,
  type ReviewRecordRepo,
} from "../../ports/review-record-repo";
import type { Db } from "./client";
import { reviewResult } from "./pg-review-record-schema";

type Row = typeof reviewResult.$inferSelect;

function toRecord(r: Row): ReviewRecord {
  const out: ReviewRecord = {
    id: r.id,
    jobId: r.jobId,
    run: r.run,
    prUrl: r.prUrl,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    source: r.source,
    requester: { kind: r.requesterKind, id: r.requesterId },
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: r.status,
    findings: r.findings,
  };
  if (r.headSha !== null) out.headSha = r.headSha;
  if (r.baseSha !== null) out.baseSha = r.baseSha;
  if (r.provider !== null) out.provider = r.provider;
  if (r.model !== null) out.model = r.model;
  if (r.verdict !== null) out.verdict = r.verdict;
  if (r.errorCategory !== null) out.errorCategory = r.errorCategory;
  if (r.summary !== null) out.summary = r.summary;
  return out;
}

/** Byte-wise id order, the same in every collation and in the fake. */
const idC = sql`${reviewResult.id} COLLATE "C"`;
const newestFirst = [desc(reviewResult.finishedAt), desc(idC)];

/**
 * Inserts one record with `db`, which may be the caller's transaction (FR-REVIEW-05: the record
 * commits with the terminal job state).
 */
export async function insertReviewRecord(
  db: Pick<Db, "insert" | "select">,
  input: NewReviewRecord,
): Promise<Result<{ record: ReviewRecord; inserted: boolean }>> {
  const valid = validateNewReviewRecord(input);
  if (!valid.ok) return valid;
  const r = valid.value;
  const [row] = await db
    .insert(reviewResult)
    .values({
      id: r.id,
      jobId: r.jobId,
      run: r.run,
      prUrl: r.prUrl,
      owner: r.owner,
      repo: r.repo,
      number: r.number,
      headSha: r.headSha ?? null,
      baseSha: r.baseSha ?? null,
      source: r.source,
      requesterKind: r.requester.kind,
      requesterId: r.requester.id,
      provider: r.provider ?? null,
      model: r.model ?? null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status,
      verdict: r.verdict ?? null,
      errorCategory: r.errorCategory ?? null,
      summary: r.summary ?? null,
      findings: [...r.findings],
    })
    // Either key (id, or the run key) makes this a no-op; the follow-up read tells them apart.
    .onConflictDoNothing()
    .returning();
  if (row) return ok({ record: toRecord(row), inserted: true });
  const [existing] = await db
    .select()
    .from(reviewResult)
    .where(
      and(
        eq(reviewResult.jobId, r.jobId),
        eq(reviewResult.prUrl, r.prUrl),
        eq(reviewResult.run, r.run),
      ),
    );
  if (existing) return ok({ record: toRecord(existing), inserted: false });
  return err({ kind: "conflict", reason: "review record id already used" });
}

export class PgReviewRecordRepo implements ReviewRecordRepo {
  constructor(private readonly db: Db) {}

  insert(record: NewReviewRecord): Promise<Result<{ record: ReviewRecord; inserted: boolean }>> {
    return insertReviewRecord(this.db, record);
  }

  async get(id: string): Promise<ReviewRecord | null> {
    if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
    const [row] = await this.db.select().from(reviewResult).where(eq(reviewResult.id, id));
    return row ? toRecord(row) : null;
  }

  async latestForPr(prUrl: string): Promise<ReviewRecord | null> {
    if (typeof prUrl !== "string" || prUrl.length === 0 || prUrl.length > 500) return null;
    const [row] = await this.db
      .select()
      .from(reviewResult)
      .where(eq(reviewResult.prUrl, prUrl))
      .orderBy(...newestFirst)
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async list(query: ReviewRecordQuery): Promise<Result<ReviewRecordPage>> {
    const v = validateReviewRecordQuery(query);
    if (!v.ok) return v;
    const q = v.value;
    const where: SQL[] = [];
    if (q.owner !== undefined) where.push(sql`lower(${reviewResult.owner}) = lower(${q.owner})`);
    if (q.repo !== undefined) where.push(sql`lower(${reviewResult.repo}) = lower(${q.repo})`);
    if (q.number !== undefined) where.push(eq(reviewResult.number, q.number));
    if (q.prUrl !== undefined) where.push(eq(reviewResult.prUrl, q.prUrl));
    if (q.status !== undefined) where.push(eq(reviewResult.status, q.status));
    if (q.source !== undefined) where.push(eq(reviewResult.source, q.source));
    if (q.from !== undefined) where.push(gte(reviewResult.finishedAt, q.from));
    if (q.to !== undefined) where.push(lte(reviewResult.finishedAt, q.to));
    if (q.cursor !== undefined) {
      const at = new Date(q.cursor.finishedAtMs);
      where.push(
        or(
          lt(reviewResult.finishedAt, at),
          and(eq(reviewResult.finishedAt, at), sql`${idC} < ${q.cursor.id}`),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(reviewResult)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(...newestFirst)
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit).map(toRecord);
    const last = items.at(-1);
    const nextCursor =
      rows.length > q.limit && last
        ? encodeReviewRecordCursor({ finishedAtMs: last.finishedAt.getTime(), id: last.id })
        : null;
    return ok({ items, nextCursor });
  }
}
