import { err, ok, type Result } from "../domain/shared/result";

export type ThreadKey = { channel: string; threadTs: string };

export type ThreadReview = ThreadKey & {
  /** Every PR the thread has asked about, in first-seen order. */
  prUrls: string[];
  /** The Slack user who started the thread's review. Never changed by later reviews. */
  requesterSlackId: string;
  latestReviewId: string;
  /** Starts at 1 and increases by one per recorded review. Orders reaction targets. */
  reviewSeq: number;
  statusMessageTs: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RecordThreadReview = ThreadKey & {
  prUrls: readonly string[];
  requesterSlackId: string;
  reviewId: string;
  /** Kept from the previous review when omitted. */
  statusMessageTs?: string;
};

/**
 * (channel, thread_ts) → review (`slack_review_thread`, FR-SLACK-13): how a thread command finds
 * its PR. The implementation receives its `Clock` at construction.
 */
export interface ThreadReviewIndex {
  /**
   * Upserts the thread: unions `prUrls`, sets `latestReviewId`, and increments `reviewSeq`
   * atomically (concurrent calls get distinct seqs). The first requester is kept.
   */
  recordReview(input: RecordThreadReview): Promise<Result<ThreadReview>>;
  /** `not_found` for an unknown thread. */
  setStatusMessage(key: ThreadKey, statusMessageTs: string): Promise<Result<ThreadReview>>;
  get(key: ThreadKey): Promise<ThreadReview | null>;
}

// ---- Boundary validation, shared by every implementation ----

/** Slack conversation ids: C (channel), G (private/group), D (DM). */
export const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]{2,30}$/;
/** Slack message timestamps: `1730000000.123456`. */
export const SLACK_TS = /^\d{9,11}\.\d{6}$/;
const SLACK_USER_ID = /^[UWB][A-Z0-9]{2,30}$/;
const MAX_PRS = 20;

export function validateThreadKey(key: ThreadKey): Result<ThreadKey> {
  if (!key || typeof key.channel !== "string" || !SLACK_CHANNEL_ID.test(key.channel))
    return err({ kind: "validation", field: "channel", message: "invalid Slack channel id" });
  if (typeof key.threadTs !== "string" || !SLACK_TS.test(key.threadTs))
    return err({ kind: "validation", field: "threadTs", message: "invalid Slack ts" });
  return ok({ channel: key.channel, threadTs: key.threadTs });
}

export function validateRecordThreadReview(input: RecordThreadReview): Result<RecordThreadReview> {
  const key = validateThreadKey(input);
  if (!key.ok) return key;
  if (
    !Array.isArray(input.prUrls) ||
    input.prUrls.length === 0 ||
    input.prUrls.length > MAX_PRS ||
    !input.prUrls.every((u) => typeof u === "string" && u.startsWith("https://") && u.length <= 500)
  )
    return err({ kind: "validation", field: "prUrls", message: "1..20 https PR URLs" });
  if (typeof input.requesterSlackId !== "string" || !SLACK_USER_ID.test(input.requesterSlackId))
    return err({ kind: "validation", field: "requesterSlackId", message: "invalid Slack user id" });
  if (
    typeof input.reviewId !== "string" ||
    input.reviewId.length === 0 ||
    input.reviewId.length > 200
  )
    return err({ kind: "validation", field: "reviewId", message: "invalid review id" });
  if (input.statusMessageTs !== undefined && !SLACK_TS.test(input.statusMessageTs))
    return err({ kind: "validation", field: "statusMessageTs", message: "invalid Slack ts" });
  return ok(input);
}

/** Order-preserving union, without duplicates. */
export function unionPrUrls(existing: readonly string[], added: readonly string[]): string[] {
  const out = [...existing];
  for (const u of added) if (!out.includes(u)) out.push(u);
  return out.slice(0, 100);
}
