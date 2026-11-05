import type { DomainError, Result } from "../domain/shared/result";
import type { NewReviewJob, ReviewJob } from "../domain/review-queue/types";

/** The implementation receives its `Clock` at construction; no method takes `now`. */
export interface ReviewJobRepo {
  /** A duplicate id gives `conflict`. Sets `version = 1`, `attempts = 0`, `createdAt = updatedAt = now`. */
  create(job: NewReviewJob): Promise<Result<ReviewJob, DomainError>>;
  get(id: string): Promise<ReviewJob | null>;
  /**
   * Atomically claims the oldest job that is `queued` with
   * `nextAttemptAt` null or `<= now`, or `running` with `leaseUntil < now`.
   * Sets `state = running`, the lease, `attempts += 1` and `version += 1`.
   *
   * Reclaiming a `running` job whose lease expired counts as one interruption: the same statement
   * also sets `interruptions += 1` and keeps `runStartedAt`. The repo never fails a job itself; a
   * reclaimed job that reached `MAX_INTERRUPTIONS` is returned as usual, and the caller sends the
   * domain event `interruption_limit`, which fails it as `interrupted` through the normal terminal
   * transition, so its record, outbox rows and reply are still written (architecture.md §4).
   */
  claimNext(opts: { owner: string; leaseMs: number }): Promise<ReviewJob | null>;
  /** False unless `owner` still holds an unexpired lease. */
  extendLease(id: string, owner: string, leaseMs: number): Promise<boolean>;
  /**
   * Compare-and-set. Writes only if the stored version equals `expectedVersion` and, when
   * `owner` is given, that owner still holds an unexpired lease. Otherwise `conflict`
   * (also `not_found` for an unknown id). `id`, `createdAt` come from the stored row.
   */
  save(
    job: ReviewJob,
    opts: { expectedVersion: number; owner?: string },
  ): Promise<Result<ReviewJob, DomainError>>;
  /** Newest first. */
  listRecent(opts: { limit: number }): Promise<ReviewJob[]>;
  /** Retention: deletes `done`/`failed` jobs whose `updatedAt` is before `date`. Returns the count. */
  deleteFinishedBefore(date: Date): Promise<number>;
}
