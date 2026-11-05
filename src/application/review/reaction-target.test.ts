import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHANGES,
  FORCE_APPROVED,
  MERGED,
  PASSED,
  PENDING,
  targetReactions,
} from "../../domain/slack/status-emoji";
import { validateReactionTarget } from "../../ports/reaction-outbox";
import {
  acceptedTarget,
  aggregateStatus,
  forceApprovedTarget,
  mergedTarget,
  nextRound,
  reactionSeq,
  verdictTarget,
  type ReactionPhase,
} from "./reaction-target";

const m = {
  channel: "C0REVIEW",
  ts: "1700000000.000100",
  prUrl: "https://github.com/acme/app/pull/1",
  round: 1,
  reviewId: "rec-1",
};

describe("aggregateStatus (Q23)", () => {
  it.each([
    [["pass"], PASSED],
    [["changes_requested"], CHANGES],
    [["none"], null],
    [["pass", "pass"], PASSED],
    [["pass", "changes_requested"], CHANGES],
    [["none", "changes_requested"], CHANGES],
    [["pass", "none"], null],
    [[], null],
  ] as const)("%j → %s", (outcomes, expected) => {
    expect(aggregateStatus(outcomes)).toBe(expected);
  });
});

describe("targets", () => {
  it("builds valid outbox targets for every phase", () => {
    const targets = [
      acceptedTarget(m),
      verdictTarget({ ...m, outcomes: ["pass"] }),
      verdictTarget({ ...m, outcomes: ["none"] }),
      forceApprovedTarget(m),
      mergedTarget({ ...m, status: PASSED }),
      mergedTarget({ ...m, status: FORCE_APPROVED }),
    ];
    for (const t of targets) expect(validateReactionTarget(t).ok).toBe(true);
    expect(targets.map((t) => targetReactions(t.state))).toEqual([
      [PENDING],
      [PASSED],
      [],
      [FORCE_APPROVED],
      [PASSED, MERGED],
      [FORCE_APPROVED, MERGED],
    ]);
    expect(targets.map((t) => t.state.seq)).toEqual([4, 5, 5, 6, 7, 7]);
  });

  it("the next round starts after the thread's latest one", () => {
    expect(nextRound(null)).toBe(1);
    expect(nextRound({ reviewSeq: 3 })).toBe(4);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects round %s", (round) => {
    expect(() => reactionSeq(round, "verdict")).toThrow(RangeError);
  });

  it("every transition of a later round sorts after every transition of an earlier one", () => {
    const phase = fc.constantFrom<ReactionPhase>("accepted", "verdict", "forceApproved", "merged");
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1000 }),
        phase,
        phase,
        (round, gap, a, b) => {
          expect(reactionSeq(round + gap, a)).toBeGreaterThan(reactionSeq(round, b));
        },
      ),
    );
  });
});
