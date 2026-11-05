import type { NewReviewJob, ReviewJob } from "../../domain/review-queue/types";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { ReviewJobRepo } from "../../ports/review-job-repo";
import type { Clock } from "../../ports/system";

type Row = { seq: number; job: ReviewJob };

/** Deep-ish copy: Dates, arrays and progress records never alias the stored job. */
function copy(job: ReviewJob): ReviewJob {
  return structuredClone(job);
}

/**
 * In-memory ReviewJobRepo with real semantics (CAS version, lease fencing).
 * Every method runs its read-modify-write in one synchronous section, which is
 * the in-memory equivalent of `SELECT ... FOR UPDATE SKIP LOCKED`: parallel
 * `claimNext()` calls interleave only at the `await` boundary, never inside it.
 */
export class InMemoryReviewJobRepo implements ReviewJobRepo {
  private rows = new Map<string, Row>();
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  async create(input: NewReviewJob): Promise<Result<ReviewJob, DomainError>> {
    if (this.rows.has(input.id)) return err({ kind: "conflict", reason: "duplicate job id" });
    const now = this.clock.now();
    const job: ReviewJob = structuredClone({
      ...input,
      nextAttemptAt: input.nextAttemptAt ?? null,
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.rows.set(job.id, { seq: ++this.seq, job });
    return ok(copy(job));
  }

  async get(id: string): Promise<ReviewJob | null> {
    const row = this.rows.get(id);
    return row ? copy(row.job) : null;
  }

  async claimNext(opts: { owner: string; leaseMs: number }): Promise<ReviewJob | null> {
    const now = this.clock.now().getTime();
    let best: Row | null = null;
    for (const row of this.rows.values()) {
      if (!this.claimable(row.job, now)) continue;
      if (
        !best ||
        row.job.createdAt.getTime() < best.job.createdAt.getTime() ||
        (row.job.createdAt.getTime() === best.job.createdAt.getTime() && row.seq < best.seq)
      ) {
        best = row;
      }
    }
    if (!best) return null;
    const job = best.job;
    // Taking over an expired lease means the previous run was interrupted (crash or hang): it
    // counts as one interruption, so a poison job cannot loop forever (state-machine.ts D12).
    if (job.state === "running") job.interruptions = (job.interruptions ?? 0) + 1;
    job.state = "running";
    job.leaseOwner = opts.owner;
    job.leaseUntil = new Date(now + opts.leaseMs);
    job.attempts += 1;
    job.version += 1;
    job.updatedAt = new Date(now);
    // The first claim of a run starts it; a lease reclaim continues the same run.
    job.runStartedAt ??= new Date(now);
    return copy(job);
  }

  async extendLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const row = this.rows.get(id);
    const now = this.clock.now().getTime();
    if (!row || !this.holdsLease(row.job, owner, now)) return false;
    row.job.leaseUntil = new Date(now + leaseMs);
    row.job.updatedAt = new Date(now);
    return true;
  }

  async save(
    job: ReviewJob,
    opts: { expectedVersion: number; owner?: string },
  ): Promise<Result<ReviewJob, DomainError>> {
    const row = this.rows.get(job.id);
    if (!row) return err({ kind: "not_found", entity: "review_job" });
    const now = this.clock.now();
    if (row.job.version !== opts.expectedVersion) {
      return err({ kind: "conflict", reason: "stale version" });
    }
    if (opts.owner !== undefined && !this.holdsLease(row.job, opts.owner, now.getTime())) {
      return err({ kind: "conflict", reason: "lease lost" });
    }
    const next: ReviewJob = {
      ...structuredClone(job),
      id: row.job.id,
      createdAt: new Date(row.job.createdAt),
      version: row.job.version + 1,
      updatedAt: now,
    };
    row.job = next;
    return ok(copy(next));
  }

  async listRecent(opts: { limit: number }): Promise<ReviewJob[]> {
    return [...this.rows.values()]
      .toSorted((a, b) => b.job.createdAt.getTime() - a.job.createdAt.getTime() || b.seq - a.seq)
      .slice(0, Math.max(0, opts.limit))
      .map((r) => copy(r.job));
  }

  async deleteFinishedBefore(date: Date): Promise<number> {
    let n = 0;
    for (const [id, row] of this.rows) {
      const finished = row.job.state === "done" || row.job.state === "failed";
      if (finished && row.job.updatedAt.getTime() < date.getTime()) {
        this.rows.delete(id);
        n += 1;
      }
    }
    return n;
  }

  private claimable(job: ReviewJob, now: number): boolean {
    switch (job.state) {
      case "queued":
        return job.nextAttemptAt === null || job.nextAttemptAt.getTime() <= now;
      case "running":
        return job.leaseUntil !== null && job.leaseUntil.getTime() < now;
      default:
        return false;
    }
  }

  private holdsLease(job: ReviewJob, owner: string, now: number): boolean {
    return job.leaseOwner === owner && job.leaseUntil !== null && job.leaseUntil.getTime() >= now;
  }
}
