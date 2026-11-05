import { err, ok, type Result } from "../domain/shared/result";
import {
  CHANGES,
  convergeOps,
  FORCE_APPROVED,
  isValidReactionSet,
  MERGED,
  PASSED,
  PENDING,
  targetReactions,
  type PrStatusState,
  type ReactionEmoji,
  type ReactionOp as DomainReactionOp,
} from "../domain/slack/status-emoji";
import { SLACK_CHANNEL_ID, SLACK_TS } from "./thread-review-index";

export type ReactionOpKind = "add" | "remove";
/**
 * `pending` → `running` (claimed, leased) → `done`, or back to `pending` with backoff, or `failed`
 * after the last attempt. A `pending` op dropped by a newer state becomes `superseded`.
 */
export type ReactionOpState = "pending" | "running" | "done" | "failed" | "superseded";

/**
 * The status-emoji state (3b, `src/domain/slack/status-emoji.ts`) one message should converge
 * to. `state.seq` orders states for the message; `state.reviewId` is stamped on the ops.
 */
export type ReactionTarget = {
  channel: string;
  ts: string;
  prUrl: string;
  state: PrStatusState;
};

/** A stored outbox row. (The domain's `ReactionOp` is the unstored plan.) */
export type OutboxOp = {
  /** Increases in enqueue order; ops of one message apply in this order. */
  id: number;
  channel: string;
  ts: string;
  prUrl: string;
  reviewId: string | null;
  seq: number;
  op: ReactionOpKind;
  emoji: ReactionEmoji;
  state: ReactionOpState;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  createdAt: Date;
};

export type EnqueueOutcome =
  | { status: "enqueued"; ops: OutboxOp[]; superseded: number }
  /** `state.seq` is older than the message's latest: nothing changed. */
  | { status: "stale"; latestSeq: number }
  /** `state.seq` equals the latest: a redelivery of the same transition, nothing changed. */
  | { status: "duplicate"; latestSeq: number };

export type MarkFailedOutcome = { state: "pending"; nextAttemptAt: Date } | { state: "failed" };

/**
 * Durable reaction writes (`reaction_outbox` + `slack_reaction`, FR-SLACK-08, FR-SLACK-14).
 * The implementation receives its `Clock` and `ReactionRetryPolicy` at construction.
 */
export interface ReactionOutbox {
  /**
   * Serialised per message. For a newer `state.seq`: drops the message's pending ops that
   * `isStaleOp`, then enqueues `convergeOps(placed, state)`, where `placed` is what
   * `slack_reaction` records as on the message (see `planConvergence` for ops still in flight).
   */
  enqueue(target: ReactionTarget): Promise<Result<EnqueueOutcome>>;
  /**
   * Leases up to `limit` due ops, at most one per message and only the oldest unfinished op of
   * that message (`FOR UPDATE SKIP LOCKED`). A `running` op whose lease expired is reclaimable.
   */
  claimDue(opts: { owner: string; leaseMs: number; limit: number }): Promise<OutboxOp[]>;
  /** Records the reaction as placed / removed. False if `owner` no longer holds the lease. */
  markDone(id: number, owner: string): Promise<boolean>;
  /** Backoff (honouring `retryAfterMs`) or `failed`. Null if `owner` no longer holds the lease. */
  markFailed(
    id: number,
    owner: string,
    opts?: { retryAfterMs?: number; permanent?: boolean },
  ): Promise<MarkFailedOutcome | null>;
  /** Emojis the app has placed on the message and not removed, sorted. */
  currentReactions(channel: string, ts: string): Promise<ReactionEmoji[]>;
  /** Every op of the message, oldest first (diagnostics and tests). */
  listForMessage(channel: string, ts: string): Promise<OutboxOp[]>;
  /**
   * Retention: deletes `done`, `failed` and `superseded` ops created before `date`, except those
   * of the message's latest seq, which keep the stale check working.
   */
  deleteFinishedBefore(date: Date): Promise<number>;
}

// ---- Shared, pure rules: every implementation uses these ----

export type ReactionRetryPolicy = {
  baseMs: number;
  maxMs: number;
  /** Attempts after which an op becomes `failed`. */
  maxAttempts: number;
  /** Returns [0, 1). Adds up to 25 % jitter. Injected so tests are deterministic. */
  jitter: () => number;
};

export const DEFAULT_REACTION_RETRY: Omit<ReactionRetryPolicy, "jitter"> = {
  baseMs: 30_000,
  maxMs: 15 * 60_000,
  maxAttempts: 8,
};

/** Delay after the `attempts`-th failure (attempts >= 1). Never below `retryAfterMs`. */
export function reactionBackoffMs(
  attempts: number,
  policy: ReactionRetryPolicy,
  retryAfterMs?: number,
): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempts - 1));
  const j = Math.min(Math.max(policy.jitter(), 0), 0.999_999);
  const delay = Math.round(exp * (1 + 0.25 * j));
  const floor = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.max(delay, Math.max(0, Math.round(floor)));
}

/**
 * The ops a new state needs, built with 3b's `convergeOps`. Ops still in flight (`running`,
 * possibly with an expired lease) may or may not land, so removes are planned against what may
 * be on the message and adds against what surely is. An extra remove (`no_reaction`) or add
 * (`already_reacted`) is a harmless success; a missing one can leave two status emoji.
 * Removes come first, so every intermediate set stays valid.
 */
export function planConvergence(
  placed: readonly ReactionEmoji[],
  inFlight: readonly Pick<OutboxOp, "op" | "emoji">[],
  state: PrStatusState,
): DomainReactionOp[] {
  const maybePlaced = new Set<ReactionEmoji>([
    ...placed,
    ...inFlight.filter((f) => f.op === "add").map((f) => f.emoji),
  ]);
  const surelyPlaced = placed.filter(
    (e) => !inFlight.some((f) => f.op === "remove" && f.emoji === e),
  );
  if (inFlight.length === 0) return convergeOps(placed, state);
  return [
    ...convergeOps(maybePlaced, state).filter((o) => o.action === "remove"),
    ...convergeOps(surelyPlaced, state).filter((o) => o.action === "add"),
  ];
}

const STATUSES: ReadonlySet<unknown> = new Set([PENDING, PASSED, CHANGES, FORCE_APPROVED]);
const ALL_EMOJI: ReadonlySet<unknown> = new Set([PENDING, PASSED, CHANGES, FORCE_APPROVED, MERGED]);

export const isReactionEmoji = (e: unknown): e is ReactionEmoji => ALL_EMOJI.has(e);

export function validateReactionTarget(t: ReactionTarget): Result<ReactionTarget> {
  const bad = (field: string, message: string) =>
    err({ kind: "validation" as const, field, message });
  if (!t || typeof t.channel !== "string" || !SLACK_CHANNEL_ID.test(t.channel))
    return bad("channel", "invalid Slack channel id");
  if (typeof t.ts !== "string" || !SLACK_TS.test(t.ts)) return bad("ts", "invalid Slack ts");
  if (typeof t.prUrl !== "string" || !t.prUrl.startsWith("https://") || t.prUrl.length > 500)
    return bad("prUrl", "prUrl must be an https URL");
  const s = t.state;
  if (!s || typeof s !== "object") return bad("state", "missing state");
  if (typeof s.seq !== "number" || !Number.isSafeInteger(s.seq) || s.seq < 0)
    return bad("state.seq", "seq must be a non-negative integer");
  if (
    s.reviewId !== null &&
    (typeof s.reviewId !== "string" || s.reviewId.length === 0 || s.reviewId.length > 200)
  )
    return bad("state.reviewId", "invalid review id");
  if (s.status !== null && !STATUSES.has(s.status))
    return bad("state.status", "unknown status emoji");
  if (typeof s.merged !== "boolean") return bad("state.merged", "merged must be a boolean");
  // targetReactions() silently drops an impossible ✅; refuse it here instead.
  const target = targetReactions(s);
  if (s.merged && !target.includes(MERGED)) return bad("state.merged", "✅ needs 🟢 or 🟡");
  if (!isValidReactionSet(target)) return bad("state", "invalid reaction set");
  return ok(t);
}

export function validateClaim(opts: { owner: string; leaseMs: number; limit: number }): void {
  if (
    !opts ||
    typeof opts.owner !== "string" ||
    opts.owner.length === 0 ||
    opts.owner.length > 200 ||
    !Number.isSafeInteger(opts.leaseMs) ||
    opts.leaseMs <= 0 ||
    !Number.isSafeInteger(opts.limit) ||
    opts.limit <= 0 ||
    opts.limit > 500
  )
    throw new RangeError("claimDue: invalid owner, leaseMs or limit");
}
