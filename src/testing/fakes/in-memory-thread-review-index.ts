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

const key = (k: ThreadKey) => `${k.channel}\u0000${k.threadTs}`;
const copy = (t: ThreadReview): ThreadReview => structuredClone(t);

export class InMemoryThreadReviewIndex implements ThreadReviewIndex {
  private readonly threads = new Map<string, ThreadReview>();

  constructor(private readonly clock: Clock) {}

  async recordReview(input: RecordThreadReview): Promise<Result<ThreadReview>> {
    const valid = validateRecordThreadReview(input);
    if (!valid.ok) return valid;
    const now = this.clock.now();
    const prev = this.threads.get(key(input));
    const next: ThreadReview = prev
      ? {
          ...prev,
          prUrls: unionPrUrls(prev.prUrls, input.prUrls),
          latestReviewId: input.reviewId,
          reviewSeq: prev.reviewSeq + 1,
          statusMessageTs: input.statusMessageTs ?? prev.statusMessageTs,
          updatedAt: now,
        }
      : {
          channel: input.channel,
          threadTs: input.threadTs,
          prUrls: unionPrUrls([], input.prUrls),
          requesterSlackId: input.requesterSlackId,
          latestReviewId: input.reviewId,
          reviewSeq: 1,
          statusMessageTs: input.statusMessageTs ?? null,
          createdAt: now,
          updatedAt: now,
        };
    this.threads.set(key(input), next);
    return ok(copy(next));
  }

  async setStatusMessage(k: ThreadKey, statusMessageTs: string): Promise<Result<ThreadReview>> {
    const valid = validateThreadKey(k);
    if (!valid.ok) return valid;
    if (typeof statusMessageTs !== "string" || !SLACK_TS.test(statusMessageTs))
      return err({ kind: "validation", field: "statusMessageTs", message: "invalid Slack ts" });
    const prev = this.threads.get(key(k));
    if (!prev) return err({ kind: "not_found", entity: "slack_review_thread" });
    const next = { ...prev, statusMessageTs, updatedAt: this.clock.now() };
    this.threads.set(key(k), next);
    return ok(copy(next));
  }

  async get(k: ThreadKey): Promise<ThreadReview | null> {
    if (!validateThreadKey(k).ok) return null;
    const t = this.threads.get(key(k));
    return t ? copy(t) : null;
  }
}
