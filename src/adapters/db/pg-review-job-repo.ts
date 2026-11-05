import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { NewReviewJob, ReviewJob } from "../../domain/review-queue/types";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { ReviewJobRepo } from "../../ports/review-job-repo";
import type { Clock } from "../../ports/system";
import type { Db } from "./client";
import { reviewJob } from "./schema";

type Row = typeof reviewJob.$inferSelect;

export function toReviewJob(row: Row): ReviewJob {
  const job: ReviewJob = {
    id: row.id,
    source: row.source,
    state: row.state,
    urls: row.urls,
    progress: row.progress,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    leaseOwner: row.leaseOwner,
    leaseUntil: row.leaseUntil,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.slack) job.slack = row.slack;
  if (row.actorUserId !== null) job.actorUserId = row.actorUserId;
  if (row.lastError !== null) job.lastError = row.lastError;
  if (row.resultReplySent !== null) job.resultReplySent = row.resultReplySent;
  if (row.runStartedAt !== null) job.runStartedAt = row.runStartedAt;
  if (row.interruptions !== null) job.interruptions = row.interruptions;
  if (row.expiresAt !== null) job.expiresAt = row.expiresAt;
  return job;
}

const isUniqueViolation = (error: unknown): boolean => {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
};

export class PgReviewJobRepo implements ReviewJobRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async create(input: NewReviewJob): Promise<Result<ReviewJob, DomainError>> {
    const now = this.clock.now();
    try {
      const [row] = await this.db
        .insert(reviewJob)
        .values({
          id: input.id,
          source: input.source,
          state: input.state,
          urls: input.urls,
          progress: input.progress,
          attempts: 0,
          nextAttemptAt: input.nextAttemptAt ?? null,
          leaseOwner: null,
          leaseUntil: null,
          slack: input.slack ?? null,
          actorUserId: input.actorUserId ?? null,
          lastError: input.lastError ?? null,
          resultReplySent: input.resultReplySent ?? null,
          runStartedAt: input.runStartedAt ?? null,
          interruptions: input.interruptions ?? null,
          expiresAt: input.expiresAt ?? null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return ok(toReviewJob(row!));
    } catch (error) {
      if (isUniqueViolation(error)) return err({ kind: "conflict", reason: "duplicate job id" });
      throw error;
    }
  }

  async get(id: string): Promise<ReviewJob | null> {
    const [row] = await this.db.select().from(reviewJob).where(eq(reviewJob.id, id));
    return row ? toReviewJob(row) : null;
  }

  /**
   * One atomic statement. `FOR UPDATE SKIP LOCKED` lets concurrent consumers each take a
   * different row without blocking; the lease expiry reclaims jobs of crashed consumers.
   * `now` is a bound parameter so tests control time through the injected Clock.
   * Reclaiming a `running` row (expired lease: the previous run crashed or hung) counts one
   * interruption in the same statement; SET expressions read the pre-update row, so the CASE sees
   * the state the row was picked in (state-machine.ts D12).
   */
  async claimNext(opts: { owner: string; leaseMs: number }): Promise<ReviewJob | null> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + opts.leaseMs);
    const eligible = or(
      and(
        eq(reviewJob.state, "queued"),
        or(isNull(reviewJob.nextAttemptAt), lte(reviewJob.nextAttemptAt, now)),
      ),
      and(eq(reviewJob.state, "running"), lt(reviewJob.leaseUntil, now)),
    );
    const pick = this.db
      .select({ id: reviewJob.id })
      .from(reviewJob)
      .where(eligible)
      .orderBy(asc(reviewJob.createdAt), asc(reviewJob.id))
      .limit(1)
      .for("update", { skipLocked: true });
    const [row] = await this.db
      .update(reviewJob)
      .set({
        state: "running",
        leaseOwner: opts.owner,
        leaseUntil,
        attempts: sql`${reviewJob.attempts} + 1`,
        interruptions: sql`case when ${reviewJob.state} = 'running' then coalesce(${reviewJob.interruptions}, 0) + 1 else ${reviewJob.interruptions} end`,
        version: sql`${reviewJob.version} + 1`,
        updatedAt: now,
        // The first claim of a run starts it; a lease reclaim continues the same run.
        runStartedAt: sql`coalesce(${reviewJob.runStartedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(eq(reviewJob.id, pick))
      .returning();
    return row ? toReviewJob(row) : null;
  }

  async extendLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.db
      .update(reviewJob)
      .set({ leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
      .where(
        and(eq(reviewJob.id, id), eq(reviewJob.leaseOwner, owner), gte(reviewJob.leaseUntil, now)),
      )
      .returning({ id: reviewJob.id });
    return rows.length > 0;
  }

  /** Single compare-and-set UPDATE; a follow-up SELECT only classifies a miss. */
  async save(
    job: ReviewJob,
    opts: { expectedVersion: number; owner?: string },
  ): Promise<Result<ReviewJob, DomainError>> {
    const now = this.clock.now();
    const guards = [eq(reviewJob.id, job.id), eq(reviewJob.version, opts.expectedVersion)];
    if (opts.owner !== undefined) {
      guards.push(eq(reviewJob.leaseOwner, opts.owner), gte(reviewJob.leaseUntil, now));
    }
    const [row] = await this.db
      .update(reviewJob)
      .set({
        source: job.source,
        state: job.state,
        urls: job.urls,
        progress: job.progress,
        attempts: job.attempts,
        nextAttemptAt: job.nextAttemptAt,
        leaseOwner: job.leaseOwner,
        leaseUntil: job.leaseUntil,
        slack: job.slack ?? null,
        actorUserId: job.actorUserId ?? null,
        lastError: job.lastError ?? null,
        resultReplySent: job.resultReplySent ?? null,
        runStartedAt: job.runStartedAt ?? null,
        interruptions: job.interruptions ?? null,
        expiresAt: job.expiresAt ?? null,
        version: sql`${reviewJob.version} + 1`,
        updatedAt: now,
      })
      .where(and(...guards))
      .returning();
    if (row) return ok(toReviewJob(row));

    const [current] = await this.db
      .select({ version: reviewJob.version })
      .from(reviewJob)
      .where(eq(reviewJob.id, job.id));
    if (!current) return err({ kind: "not_found", entity: "review_job" });
    return err({
      kind: "conflict",
      reason: current.version !== opts.expectedVersion ? "stale version" : "lease lost",
    });
  }

  async listRecent(opts: { limit: number }): Promise<ReviewJob[]> {
    const rows = await this.db
      .select()
      .from(reviewJob)
      .orderBy(desc(reviewJob.createdAt), desc(reviewJob.id))
      .limit(Math.max(0, opts.limit));
    return rows.map(toReviewJob);
  }

  async deleteFinishedBefore(date: Date): Promise<number> {
    const rows = await this.db
      .delete(reviewJob)
      .where(and(inArray(reviewJob.state, ["done", "failed"]), lt(reviewJob.updatedAt, date)))
      .returning({ id: reviewJob.id });
    return rows.length;
  }
}
