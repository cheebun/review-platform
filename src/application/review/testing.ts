/**
 * In-memory doubles for the interfaces in `./ports`, for this layer's tests and for 3g's.
 * Real behaviour, not mocks: the unit of work really rolls back, the reaction sender really
 * holds a reaction set per message.
 */
import type { ReviewJob } from "../../domain/review-queue/types";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { ReactionEmoji } from "../../domain/slack/status-emoji";
import {
  validateReactionTarget,
  type EnqueueOutcome,
  type ReactionOutbox,
  type ReactionTarget,
} from "../../ports/reaction-outbox";
import type { NewReviewEvent, ReviewEventRepo } from "../../ports/review-event-repo";
import type { ReviewJobRepo } from "../../ports/review-job-repo";
import {
  validateNewReviewRecord,
  type NewReviewRecord,
  type ReviewRecordRepo,
} from "../../ports/review-record-repo";
import {
  unionPrUrls,
  validateRecordThreadReview,
  type RecordThreadReview,
  type ThreadReview,
  type ThreadReviewIndex,
} from "../../ports/thread-review-index";
import type { Clock } from "../../ports/system";
import type { ReactionSender, ReviewTx, ReviewUnitOfWork, ThreadReplier, Timers } from "./ports";

type Staged = () => Promise<unknown>;

/**
 * Stages every write and applies them only when `fn` resolves `ok`, one run at a time. Reads
 * inside the run (the job's version, the thread's seq) see the stores as they were, which is what
 * a serialised transaction sees. `failCommits` makes the next N commits fail before any write.
 */
export class InMemoryReviewUnitOfWork implements ReviewUnitOfWork {
  commits = 0;
  rollbacks = 0;
  private failCommits = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly stores: {
      jobs: ReviewJobRepo;
      records: ReviewRecordRepo;
      events: ReviewEventRepo;
      threads: ThreadReviewIndex;
      outbox: ReactionOutbox;
      clock: Clock;
    },
  ) {}

  failNextCommit(times = 1): void {
    this.failCommits += times;
  }

  run<T>(fn: (tx: ReviewTx) => Promise<Result<T>>): Promise<Result<T>> {
    const next = this.chain.then(() => this.runNow(fn));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runNow<T>(fn: (tx: ReviewTx) => Promise<Result<T>>): Promise<Result<T>> {
    const staged: Staged[] = [];
    const s = this.stores;
    const tx: ReviewTx = {
      saveJob: async (job: ReviewJob, opts) => {
        const current = await s.jobs.get(job.id);
        if (!current) return err({ kind: "not_found", entity: "review_job" });
        if (current.version !== opts.expectedVersion)
          return err({ kind: "conflict", reason: "stale version" });
        const now = s.clock.now().getTime();
        if (
          opts.owner !== undefined &&
          (current.leaseOwner !== opts.owner || (current.leaseUntil?.getTime() ?? 0) < now)
        )
          return err({ kind: "conflict", reason: "lease lost" });
        staged.push(async () => {
          const saved = await s.jobs.save(job, opts);
          if (!saved.ok) throw new Error(`staged save failed: ${saved.error.kind}`);
        });
        return ok({ ...job, version: current.version + 1, updatedAt: s.clock.now() });
      },
      insertRecord: async (record: NewReviewRecord) => {
        const valid = validateNewReviewRecord(record);
        if (!valid.ok) return valid;
        staged.push(() => s.records.insert(record));
        return ok({ record: { ...record, findings: [...record.findings] }, inserted: true });
      },
      recordThreadReview: async (input: RecordThreadReview) => {
        const valid = validateRecordThreadReview(input);
        if (!valid.ok) return valid;
        const existing = await s.threads.get(input);
        staged.push(() => s.threads.recordReview(input));
        const now = s.clock.now();
        const view: ThreadReview = {
          channel: input.channel,
          threadTs: input.threadTs,
          prUrls: unionPrUrls(existing?.prUrls ?? [], input.prUrls),
          requesterSlackId: existing?.requesterSlackId ?? input.requesterSlackId,
          latestReviewId: input.reviewId,
          reviewSeq: (existing?.reviewSeq ?? 0) + 1,
          statusMessageTs: input.statusMessageTs ?? existing?.statusMessageTs ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        return ok(view);
      },
      enqueueReaction: async (target: ReactionTarget) => {
        const valid = validateReactionTarget(target);
        if (!valid.ok) return valid;
        staged.push(() => s.outbox.enqueue(target));
        return ok<EnqueueOutcome>({ status: "enqueued", ops: [], superseded: 0 });
      },
      appendEvent: async (event: NewReviewEvent) => {
        staged.push(() => s.events.append(event));
        return { inserted: true };
      },
    };
    let out: Result<T>;
    try {
      out = await fn(tx);
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
    if (!out.ok) {
      this.rollbacks += 1;
      return out;
    }
    if (this.failCommits > 0) {
      this.failCommits -= 1;
      this.rollbacks += 1;
      throw new Error("injected commit failure");
    }
    for (const write of staged) await write();
    this.commits += 1;
    return out;
  }
}

type Message = { channel: string; ts: string };
const key = (m: Message) => `${m.channel}\u0000${m.ts}`;

/**
 * Slack reactions as a set per message. `already_reacted` / `no_reaction` are successes, as the
 * real sender must report them. Script failures with `failNext`.
 */
export class FakeReactionSender implements ReactionSender {
  readonly calls: { op: "add" | "remove"; channel: string; ts: string; emoji: ReactionEmoji }[] =
    [];
  private readonly sets = new Map<string, Set<ReactionEmoji>>();
  private failures: DomainError[] = [];

  failNext(error: DomainError, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(error);
  }

  reactions(m: Message): ReactionEmoji[] {
    return [...(this.sets.get(key(m)) ?? [])].toSorted();
  }

  async add(input: Message & { emoji: ReactionEmoji }): Promise<Result<void>> {
    return this.apply("add", input);
  }

  async remove(input: Message & { emoji: ReactionEmoji }): Promise<Result<void>> {
    return this.apply("remove", input);
  }

  private apply(op: "add" | "remove", input: Message & { emoji: ReactionEmoji }): Result<void> {
    this.calls.push({ op, ...input });
    const failure = this.failures.shift();
    if (failure) return err(failure);
    const set = this.sets.get(key(input)) ?? new Set<ReactionEmoji>();
    if (op === "add") set.add(input.emoji);
    else set.delete(input.emoji);
    this.sets.set(key(input), set);
    return ok(undefined);
  }
}

export class FakeThreadReplier implements ThreadReplier {
  readonly replies: { channel: string; threadTs: string; text: string }[] = [];
  private failures: DomainError[] = [];

  failNext(error: DomainError, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(error);
  }

  async reply(input: { channel: string; threadTs: string; text: string }): Promise<Result<void>> {
    const failure = this.failures.shift();
    if (failure) return err(failure);
    this.replies.push(input);
    return ok(undefined);
  }
}

/**
 * `sleep` returns at once and records the delay; `deadline` never fires unless `fireDeadlines`
 * is set, so a test decides whether a call times out.
 */
export class FakeTimers implements Timers {
  readonly sleeps: number[] = [];
  fireDeadlines = false;
  cancelled = 0;

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }

  deadline(_ms: number): { done: Promise<void>; cancel(): void } {
    const done = this.fireDeadlines ? Promise.resolve() : new Promise<void>(() => {});
    return { done, cancel: () => void (this.cancelled += 1) };
  }
}
