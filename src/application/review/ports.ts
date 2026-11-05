/**
 * Narrow interfaces owned by the review application layer. 3g implements the Slack ones with the
 * Slack adapter; 3w wires the unit of work (`src/server/workers/pg-review-unit-of-work.ts`).
 */
import type { ReviewJob } from "../../domain/review-queue/types";
import type { DomainError, Result } from "../../domain/shared/result";
import type { ReactionEmoji } from "../../domain/slack/status-emoji";
import type { EnqueueOutcome, ReactionTarget } from "../../ports/reaction-outbox";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import type { NewReviewRecord, ReviewRecord } from "../../ports/review-record-repo";
import type { ReviewerSource } from "../../ports/reviewer";
import type { RecordThreadReview, ThreadReview } from "../../ports/thread-review-index";

/** Posts one message in a Slack thread, as the owner. Never throws. */
export interface ThreadReplier {
  reply(input: { channel: string; threadTs: string; text: string }): Promise<Result<void>>;
}

/**
 * Adds or removes one reaction on one message, as the owner. Never throws. `already_reacted`
 * (add) and `no_reaction` (remove) MUST be returned as success. A Slack 429 is
 * `rate_limited` with its `Retry-After`; a message or channel that is gone is `not_found`.
 */
export interface ReactionSender {
  add(input: { channel: string; ts: string; emoji: ReactionEmoji }): Promise<Result<void>>;
  remove(input: { channel: string; ts: string; emoji: ReactionEmoji }): Promise<Result<void>>;
}

/** The configured reviewer, resolved per call (settings may change without a restart). */
export type { ReviewerSource };

/** Waiting, injected so tests never sleep. */
export interface Timers {
  sleep(ms: number): Promise<void>;
  /** Resolves after `ms` unless cancelled; `cancel` releases the underlying timer. */
  deadline(ms: number): { done: Promise<void>; cancel(): void };
}

/**
 * The writes that must commit together (FR-REVIEW-05, FR-SLACK-08, FR-SHIP-08). Every method
 * runs inside the one transaction opened by `ReviewUnitOfWork.run`.
 */
export interface ReviewTx {
  /** Compare-and-set, as `ReviewJobRepo.save`. */
  saveJob(
    job: ReviewJob,
    opts: { expectedVersion: number; owner?: string },
  ): Promise<Result<ReviewJob, DomainError>>;
  insertRecord(
    record: NewReviewRecord,
  ): Promise<Result<{ record: ReviewRecord; inserted: boolean }>>;
  recordThreadReview(input: RecordThreadReview): Promise<Result<ThreadReview>>;
  enqueueReaction(target: ReactionTarget): Promise<Result<EnqueueOutcome>>;
  appendEvent(event: NewReviewEvent): Promise<{ inserted: boolean }>;
}

export interface ReviewUnitOfWork {
  /**
   * Runs `fn` in one transaction. It commits only when `fn` resolves `ok`; an `err` result or a
   * throw rolls every write back (the throw is re-thrown, the `err` is returned).
   */
  run<T>(fn: (tx: ReviewTx) => Promise<Result<T>>): Promise<Result<T>>;
}

/** WakeUp channel the enqueuer notifies and the consumer subscribes to (architecture §5). */
export const REVIEW_JOB_WAKE_CHANNEL = "review-job:wake";
