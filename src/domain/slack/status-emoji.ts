/**
 * Status-emoji machine for one PR on its Slack status message (architecture §4.1,
 * FR-SLACK-05, FR-SLACK-08, FR-SLACK-14, FR-SHIP-06, FR-SHIP-08). Pure.
 *
 *   (none) ─accepted─▶ ⏳ ─passed─▶ 🟢 ─merged─▶ 🟢✅
 *                      ⏳ ─changes─▶ 🔴 ─forceApproved─▶ 🟡 ─merged─▶ 🟡✅
 *                      ⏳ ─errored─▶ (none)
 *   🟢 / 🔴 / 🟡 / (none) ─reReviewAccepted─▶ ⏳
 *
 * Invariants (property-tested): at most one of ⏳ 🟢 🔴 🟡 at a time; ✅ only next to 🟢 or 🟡,
 * and only after `merged`. Every op batch removes before it adds, so each intermediate reaction
 * set also satisfies the invariant.
 *
 * Supersession: every applied transition bumps `seq`, and its ops carry that `seq` and the
 * round's `reviewId`. The outbox drops pending ops with `isStaleOp(op, latestSeq)` and replaces
 * them with `convergeOps(placed, latestState)`, which diffs against what Slack actually holds.
 * Verdict events for another review id are rejected as `stale_review`.
 */
import { err, ok, type DomainError, type Result } from "../shared/result";

export const PENDING = "hourglass_flowing_sand";
export const PASSED = "large_green_circle";
export const CHANGES = "red_circle";
export const FORCE_APPROVED = "large_yellow_circle";
export const MERGED = "white_check_mark";

export type StatusEmoji = typeof PENDING | typeof PASSED | typeof CHANGES | typeof FORCE_APPROVED;
export type ReactionEmoji = StatusEmoji | typeof MERGED;

const STATUS_EMOJI: ReadonlySet<ReactionEmoji> = new Set([
  PENDING,
  PASSED,
  CHANGES,
  FORCE_APPROVED,
]);

export type PrStatusState = {
  /** The PR's one status emoji, or null for none. */
  status: StatusEmoji | null;
  /** ✅ is placed. Only ever true with 🟢 or 🟡. */
  merged: boolean;
  /** Bumped on every transition that changes the target. Stamped on its ops. */
  seq: number;
  /** The review round that `status` belongs to. */
  reviewId: string | null;
};

export const INITIAL_PR_STATUS: PrStatusState = {
  status: null,
  merged: false,
  seq: 0,
  reviewId: null,
};

export type StatusEvent =
  /** A first request was accepted and its job enqueued (FR-SLACK-05). */
  | { type: "accepted"; reviewId: string }
  /** `updated` with new commits, or the owner's `review` (FR-SLACK-14). */
  | { type: "reReviewAccepted"; reviewId: string }
  | { type: "reviewPassed"; reviewId: string }
  | { type: "reviewChanges"; reviewId: string }
  /** Errored, or abandoned after the maximum attempts (FR-SLACK-08). */
  | { type: "reviewErrored"; reviewId: string }
  /** `updated` with no new commits: no ⏳, emoji unchanged. */
  | { type: "reviewSkippedNoCommits" }
  | { type: "forceApproved" }
  /** A confirmed merge (FR-SHIP-08). */
  | { type: "merged" };

export type ReactionOp = {
  action: "remove" | "add";
  emoji: ReactionEmoji;
  seq: number;
  reviewId: string | null;
};

export type StatusTransition = { state: PrStatusState; ops: ReactionOp[] };

/** The reactions Slack should hold for this state: the status emoji first, then ✅. */
export function targetReactions(state: PrStatusState): ReactionEmoji[] {
  const target: ReactionEmoji[] = [];
  if (state.status) target.push(state.status);
  if (state.merged && (state.status === PASSED || state.status === FORCE_APPROVED))
    target.push(MERGED);
  return target;
}

/**
 * Reactions to remove and add to get from `placed` to `target`. Removes take ✅ off first, adds
 * put it on last, so ✅ is never left alone.
 */
export function diffReactions(
  placed: Iterable<ReactionEmoji>,
  target: Iterable<ReactionEmoji>,
): { remove: ReactionEmoji[]; add: ReactionEmoji[] } {
  const have = new Set(placed);
  const want = new Set(target);
  const remove = [...have].filter((e) => !want.has(e));
  const add = [...want].filter((e) => !have.has(e));
  remove.sort((a, b) => Number(b === MERGED) - Number(a === MERGED));
  add.sort((a, b) => Number(a === MERGED) - Number(b === MERGED));
  return { remove, add };
}

/** At most one status emoji, and ✅ only next to 🟢 or 🟡. */
export function isValidReactionSet(reactions: Iterable<ReactionEmoji>): boolean {
  const set = new Set(reactions);
  const statuses = [...set].filter((e) => STATUS_EMOJI.has(e));
  if (statuses.length > 1) return false;
  if (set.has(MERGED) && !set.has(PASSED) && !set.has(FORCE_APPROVED)) return false;
  return true;
}

const toOps = (
  diff: { remove: ReactionEmoji[]; add: ReactionEmoji[] },
  state: PrStatusState,
): ReactionOp[] => [
  ...diff.remove.map((emoji) => ({
    action: "remove" as const,
    emoji,
    seq: state.seq,
    reviewId: state.reviewId,
  })),
  ...diff.add.map((emoji) => ({
    action: "add" as const,
    emoji,
    seq: state.seq,
    reviewId: state.reviewId,
  })),
];

/** Ops that take the actually placed reactions to `state`'s target, stamped with its seq. */
export function convergeOps(placed: Iterable<ReactionEmoji>, state: PrStatusState): ReactionOp[] {
  return toOps(diffReactions(placed, targetReactions(state)), state);
}

/** An op from an older transition than the latest one for this PR. */
export function isStaleOp(op: Pick<ReactionOp, "seq">, latestSeq: number): boolean {
  return op.seq < latestSeq;
}

const conflict = (reason: string): { ok: false; error: DomainError } =>
  err({ kind: "conflict", reason });

const noop = (state: PrStatusState): Result<StatusTransition, DomainError> =>
  ok({ state, ops: [] });

function move(
  state: PrStatusState,
  patch: Pick<PrStatusState, "status" | "merged" | "reviewId">,
): Result<StatusTransition, DomainError> {
  const next: PrStatusState = { ...patch, seq: state.seq + 1 };
  return ok({
    state: next,
    ops: toOps(diffReactions(targetReactions(state), targetReactions(next)), next),
  });
}

const VERDICT: Record<"reviewPassed" | "reviewChanges" | "reviewErrored", StatusEmoji | null> = {
  reviewPassed: PASSED,
  reviewChanges: CHANGES,
  reviewErrored: null,
};

/**
 * Apply one event. Illegal events return `conflict` and change nothing. Redelivered events
 * (same review id, same outcome) are no-ops with no ops.
 */
export function applyStatusEvent(
  state: PrStatusState,
  event: StatusEvent,
): Result<StatusTransition, DomainError> {
  switch (event.type) {
    case "accepted":
    case "reReviewAccepted": {
      if (state.status === PENDING)
        return state.reviewId === event.reviewId ? noop(state) : conflict("review_in_progress");
      if (state.merged) return conflict("already_merged");
      // A first request starts from none; re-reviews may start from any settled state.
      if (event.type === "accepted" && state.status !== null) return conflict("already_reviewed");
      return move(state, { status: PENDING, merged: false, reviewId: event.reviewId });
    }
    case "reviewPassed":
    case "reviewChanges":
    case "reviewErrored": {
      if (event.reviewId !== state.reviewId) return conflict("stale_review");
      const outcome = VERDICT[event.type];
      if (state.status === PENDING)
        return move(state, { status: outcome, merged: false, reviewId: state.reviewId });
      return state.status === outcome && !state.merged ? noop(state) : conflict("not_pending");
    }
    case "reviewSkippedNoCommits":
      return noop(state);
    case "forceApproved": {
      if (state.merged) return conflict("already_merged");
      if (state.status === FORCE_APPROVED) return noop(state);
      if (state.status !== CHANGES) return conflict("not_changes_requested");
      return move(state, { status: FORCE_APPROVED, merged: false, reviewId: state.reviewId });
    }
    case "merged": {
      if (state.merged) return noop(state);
      if (state.status !== PASSED && state.status !== FORCE_APPROVED)
        return conflict("not_approved");
      return move(state, { status: state.status, merged: true, reviewId: state.reviewId });
    }
  }
}
