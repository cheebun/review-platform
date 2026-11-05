/**
 * Status-emoji targets for the reaction outbox (architecture §4.1, FR-SLACK-08, FR-SLACK-14,
 * FR-SHIP-06, FR-SHIP-08). Pure.
 *
 * Ordering. The outbox keeps one `seq` per status message and drops anything not newer than the
 * latest. Every transition of one review round of a thread gets a fixed slot, so redeliveries are
 * `duplicate`, and a late transition of an older round is `stale`:
 *
 *   seq = round * 4 + phase   (accepted 0 → verdict 1 → force approved 2 → merged 3)
 *
 * `round` is the thread's `reviewSeq` (`ThreadReviewIndex`), which the terminal transition of each
 * review bumps by one. A round that is about to start (⏳ at intake, 3g) is `thread.reviewSeq + 1`
 * (1 for a thread that has none), so ⏳ always sorts after every transition of the previous round.
 */
import {
  CHANGES,
  FORCE_APPROVED,
  PASSED,
  PENDING,
  type StatusEmoji,
} from "../../domain/slack/status-emoji";
import type { ReactionTarget } from "../../ports/reaction-outbox";

export const REACTION_PHASE = { accepted: 0, verdict: 1, forceApproved: 2, merged: 3 } as const;
export type ReactionPhase = keyof typeof REACTION_PHASE;
const PHASES = 4;

/** Throws `RangeError` on a round that is not a positive integer: a guessed seq could go backwards. */
export function reactionSeq(round: number, phase: ReactionPhase): number {
  if (!Number.isSafeInteger(round) || round < 1 || round > Number.MAX_SAFE_INTEGER / PHASES - 1) {
    throw new RangeError("review round must be a positive integer");
  }
  return round * PHASES + REACTION_PHASE[phase];
}

/** The round a new review of the thread will get when it finishes. */
export const nextRound = (thread: { reviewSeq: number } | null | undefined): number =>
  (thread?.reviewSeq ?? 0) + 1;

/** What one PR's latest review means for the message: 🟢, 🔴, or nothing (errored / unknown). */
export type PrOutcome = "pass" | "changes_requested" | "none";

/**
 * Several PRs on one message (Q23, assumed): 🔴 if any PR is red, 🟢 only if every PR is green,
 * otherwise no status emoji. The only place the aggregation rule lives.
 */
export function aggregateStatus(outcomes: readonly PrOutcome[]): StatusEmoji | null {
  if (outcomes.includes("changes_requested")) return CHANGES;
  if (outcomes.length > 0 && outcomes.every((o) => o === "pass")) return PASSED;
  return null;
}

type Message = { channel: string; ts: string; prUrl: string; round: number; reviewId: string };

/** ⏳ when a review is accepted (FR-SLACK-05). `round` is `nextRound(thread)`. */
export function acceptedTarget(m: Message): ReactionTarget {
  return target(m, PENDING, false, "accepted");
}

/** ⏳ replaced by the verdict (or by nothing for an errored review). */
export function verdictTarget(m: Message & { outcomes: readonly PrOutcome[] }): ReactionTarget {
  return target(m, aggregateStatus(m.outcomes), false, "verdict");
}

/** 🔴 replaced by 🟡 (FR-SHIP-06). */
export function forceApprovedTarget(m: Message): ReactionTarget {
  return target(m, FORCE_APPROVED, false, "forceApproved");
}

/** ✅ next to 🟢 or 🟡 after a confirmed merge (FR-SHIP-08). */
export function mergedTarget(
  m: Message & { status: typeof PASSED | typeof FORCE_APPROVED },
): ReactionTarget {
  return target(m, m.status, true, "merged");
}

function target(
  m: Message,
  status: StatusEmoji | null,
  merged: boolean,
  phase: ReactionPhase,
): ReactionTarget {
  return {
    channel: m.channel,
    ts: m.ts,
    prUrl: m.prUrl,
    state: { status, merged, seq: reactionSeq(m.round, phase), reviewId: m.reviewId },
  };
}
