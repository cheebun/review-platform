import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyStatusEvent,
  CHANGES,
  convergeOps,
  diffReactions,
  FORCE_APPROVED,
  INITIAL_PR_STATUS,
  isStaleOp,
  isValidReactionSet,
  MERGED,
  PASSED,
  PENDING,
  targetReactions,
  type PrStatusState,
  type ReactionEmoji,
  type ReactionOp,
  type StatusEvent,
} from "./status-emoji";

// Fixed seed so CI is deterministic. Replay with FC_SEED=<n>.
const SEED = Number(process.env.FC_SEED ?? 20261104);
const RUNS = Number(process.env.FC_RUNS ?? 1000);

const GLYPH: Record<ReactionEmoji, string> = {
  [PENDING]: "⏳",
  [PASSED]: "🟢",
  [CHANGES]: "🔴",
  [FORCE_APPROVED]: "🟡",
  [MERGED]: "✅",
};
const show = (reactions: readonly ReactionEmoji[]) =>
  reactions.map((r) => GLYPH[r]).join("") || "∅";
const showOps = (ops: readonly ReactionOp[]) =>
  ops.map((o) => `${o.action === "add" ? "+" : "-"}${GLYPH[o.emoji]}`).join(" ");

const accepted = (reviewId: string): StatusEvent => ({ type: "accepted", reviewId });
const reReview = (reviewId: string): StatusEvent => ({ type: "reReviewAccepted", reviewId });
const passed = (reviewId: string): StatusEvent => ({ type: "reviewPassed", reviewId });
const changes = (reviewId: string): StatusEvent => ({ type: "reviewChanges", reviewId });
const errored = (reviewId: string): StatusEvent => ({ type: "reviewErrored", reviewId });
const skipped: StatusEvent = { type: "reviewSkippedNoCommits" };
const forceApproved: StatusEvent = { type: "forceApproved" };
const merged: StatusEvent = { type: "merged" };

/** Applies events that must all be legal; returns each step's target and ops. */
function run(events: readonly StatusEvent[], from: PrStatusState = INITIAL_PR_STATUS) {
  let state = from;
  const steps: { target: string; ops: string }[] = [];
  for (const event of events) {
    const result = applyStatusEvent(state, event);
    if (!result.ok) throw new Error(`illegal ${event.type} on ${show(targetReactions(state))}`);
    state = result.value.state;
    steps.push({ target: show(targetReactions(state)), ops: showOps(result.value.ops) });
  }
  return { state, steps };
}

const stateAt = (events: readonly StatusEvent[]) => run(events).state;

describe("documented sequences (FR-SLACK-08, FR-SLACK-14 AC 7, FR-SHIP-06)", () => {
  it.each([
    {
      name: "⏳→🔴→⏳→🟢→🟢✅ (the decided scenario, with merge)",
      events: [accepted("r1"), changes("r1"), reReview("r2"), passed("r2"), merged],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "🔴", ops: "-⏳ +🔴" },
        { target: "⏳", ops: "-🔴 +⏳" },
        { target: "🟢", ops: "-⏳ +🟢" },
        { target: "🟢✅", ops: "+✅" },
      ],
    },
    {
      name: "⏳→🔴→🟡→🟡✅ (force approve, then merge)",
      events: [accepted("r1"), changes("r1"), forceApproved, merged],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "🔴", ops: "-⏳ +🔴" },
        { target: "🟡", ops: "-🔴 +🟡" },
        { target: "🟡✅", ops: "+✅" },
      ],
    },
    {
      name: "⏳→🟢→🟢✅ (pass, auto-approve, merge)",
      events: [accepted("r1"), passed("r1"), merged],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "🟢", ops: "-⏳ +🟢" },
        { target: "🟢✅", ops: "+✅" },
      ],
    },
    {
      name: "⏳→∅ (errored or abandoned review)",
      events: [accepted("r1"), errored("r1")],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "∅", ops: "-⏳" },
      ],
    },
    {
      name: "🔴→⏳→∅ (errored re-review leaves no status emoji, AC 9)",
      events: [accepted("r1"), changes("r1"), reReview("r2"), errored("r2")],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "🔴", ops: "-⏳ +🔴" },
        { target: "⏳", ops: "-🔴 +⏳" },
        { target: "∅", ops: "-⏳" },
      ],
    },
    {
      name: "🔴 stays when updated is skipped for no new commits (AC 8)",
      events: [accepted("r1"), changes("r1"), skipped],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "🔴", ops: "-⏳ +🔴" },
        { target: "🔴", ops: "" },
      ],
    },
    {
      name: "🟢→⏳→🔴 (owner review re-run changes the verdict)",
      events: [accepted("r1"), passed("r1"), reReview("r2"), changes("r2")],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "🟢", ops: "-⏳ +🟢" },
        { target: "⏳", ops: "-🟢 +⏳" },
        { target: "🔴", ops: "-⏳ +🔴" },
      ],
    },
    {
      name: "🟡→⏳→🟢 (a later re-review replaces 🟡)",
      events: [accepted("r1"), changes("r1"), forceApproved, reReview("r2"), passed("r2")],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "🔴", ops: "-⏳ +🔴" },
        { target: "🟡", ops: "-🔴 +🟡" },
        { target: "⏳", ops: "-🟡 +⏳" },
        { target: "🟢", ops: "-⏳ +🟢" },
      ],
    },
    {
      name: "∅→⏳ after an errored round (re-review from none)",
      events: [accepted("r1"), errored("r1"), reReview("r2"), passed("r2")],
      steps: [
        { target: "⏳", ops: "+⏳" },
        { target: "∅", ops: "-⏳" },
        { target: "⏳", ops: "+⏳" },
        { target: "🟢", ops: "-⏳ +🟢" },
      ],
    },
    {
      name: "a skipped request gets no ⏳ (FR-SLACK-05)",
      events: [skipped],
      steps: [{ target: "∅", ops: "" }],
    },
  ])("$name", ({ events, steps }) => {
    expect(run(events).steps).toEqual(steps);
  });
});

describe("illegal events are conflicts and change nothing", () => {
  it.each([
    { name: "merge on 🔴", events: [accepted("r1"), changes("r1")], event: merged },
    { name: "merge on ⏳", events: [accepted("r1")], event: merged },
    { name: "merge on ∅", events: [], event: merged },
    { name: "force approve on 🟢", events: [accepted("r1"), passed("r1")], event: forceApproved },
    { name: "force approve on ⏳", events: [accepted("r1")], event: forceApproved },
    { name: "a verdict with nothing pending", events: [], event: passed("r1") },
    {
      name: "accepted on 🔴 (use reReviewAccepted)",
      events: [accepted("r1"), changes("r1")],
      event: accepted("r2"),
    },
    {
      name: "a second review while one is pending",
      events: [accepted("r1")],
      event: reReview("r2"),
    },
    {
      name: "re-review after a merge",
      events: [accepted("r1"), passed("r1"), merged],
      event: reReview("r2"),
    },
    {
      name: "force approve after a merge",
      events: [accepted("r1"), changes("r1"), forceApproved, merged],
      event: forceApproved,
    },
  ])("$name", ({ events, event }) => {
    const before = stateAt(events);
    const result = applyStatusEvent(before, event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });
});

describe("idempotent redelivery is a no-op without ops", () => {
  it.each([
    { name: "accepted twice", events: [accepted("r1")], event: accepted("r1") },
    {
      name: "re-review accepted twice",
      events: [accepted("r1"), changes("r1"), reReview("r2")],
      event: reReview("r2"),
    },
    { name: "the same verdict twice", events: [accepted("r1"), passed("r1")], event: passed("r1") },
    { name: "the same error twice", events: [accepted("r1"), errored("r1")], event: errored("r1") },
    {
      name: "force approve twice",
      events: [accepted("r1"), changes("r1"), forceApproved],
      event: forceApproved,
    },
    { name: "merged twice", events: [accepted("r1"), passed("r1"), merged], event: merged },
  ])("$name", ({ events, event }) => {
    const before = stateAt(events);
    const result = applyStatusEvent(before, event);
    expect(result).toEqual({ ok: true, value: { state: before, ops: [] } });
  });
});

describe("supersession by review id and sequence number (FR-SLACK-14 (c), AC 5)", () => {
  it("a late verdict from an older review is a stale conflict", () => {
    const before = stateAt([accepted("r1"), changes("r1"), reReview("r2")]);
    const result = applyStatusEvent(before, passed("r1"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: "conflict", reason: "stale_review" });
  });

  it("a different verdict for the same, finished review is a conflict", () => {
    const result = applyStatusEvent(stateAt([accepted("r1"), passed("r1")]), changes("r1"));
    expect(result.ok).toBe(false);
  });

  it("stamps every op with the new sequence number and review id", () => {
    const s1 = stateAt([accepted("r1"), changes("r1")]);
    const result = applyStatusEvent(s1, reReview("r2"));
    expect(result.ok && result.value.ops).toEqual([
      { action: "remove", emoji: CHANGES, seq: s1.seq + 1, reviewId: "r2" },
      { action: "add", emoji: PENDING, seq: s1.seq + 1, reviewId: "r2" },
    ]);
    expect(result.ok && result.value.state.seq).toBe(s1.seq + 1);
  });

  it("isStaleOp drops ops below the latest sequence number", () => {
    expect(isStaleOp({ seq: 2 }, 3)).toBe(true);
    expect(isStaleOp({ seq: 3 }, 3)).toBe(false);
    expect(isStaleOp({ seq: 4 }, 3)).toBe(false);
  });

  it("convergeOps rebuilds the pending ops from what is actually placed", () => {
    // ⏳ was never placed (its add was superseded), and 🔴 is still on the message.
    const state = stateAt([accepted("r1"), changes("r1"), reReview("r2"), passed("r2")]);
    expect(convergeOps([CHANGES], state)).toEqual([
      { action: "remove", emoji: CHANGES, seq: state.seq, reviewId: "r2" },
      { action: "add", emoji: PASSED, seq: state.seq, reviewId: "r2" },
    ]);
    expect(convergeOps(targetReactions(state), state)).toEqual([]);
  });
});

describe("targetReactions, diffReactions, isValidReactionSet", () => {
  it("lists the status emoji before ✅", () => {
    expect(targetReactions(stateAt([accepted("r1"), passed("r1"), merged]))).toEqual([
      PASSED,
      MERGED,
    ]);
    expect(targetReactions(INITIAL_PR_STATUS)).toEqual([]);
  });

  it("removes ✅ before the status emoji, and adds the status emoji before ✅", () => {
    expect(diffReactions([PASSED, MERGED], [PENDING])).toEqual({
      remove: [MERGED, PASSED],
      add: [PENDING],
    });
    expect(diffReactions([], [FORCE_APPROVED, MERGED])).toEqual({
      remove: [],
      add: [FORCE_APPROVED, MERGED],
    });
    expect(diffReactions([CHANGES, CHANGES], [CHANGES])).toEqual({ remove: [], add: [] });
  });

  it.each([
    [[], true],
    [[PENDING], true],
    [[PASSED, MERGED], true],
    [[FORCE_APPROVED, MERGED], true],
    [[MERGED], false],
    [[PENDING, MERGED], false],
    [[CHANGES, MERGED], false],
    [[PASSED, CHANGES], false],
    [[PENDING, PASSED], false],
  ] as [ReactionEmoji[], boolean][])("%j valid = %s", (set, valid) => {
    expect(isValidReactionSet(set)).toBe(valid);
  });
});

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

const reviewIdArb = fc.constantFrom("r1", "r2", "r3");
const eventArb: fc.Arbitrary<StatusEvent> = fc.oneof(
  reviewIdArb.map(accepted),
  reviewIdArb.map(reReview),
  reviewIdArb.map(passed),
  reviewIdArb.map(changes),
  reviewIdArb.map(errored),
  fc.constant(skipped),
  fc.constant(forceApproved),
  fc.constant(merged),
);

const apply = (placed: Set<ReactionEmoji>, op: ReactionOp) => {
  if (op.action === "add") placed.add(op.emoji);
  else placed.delete(op.emoji);
};

describe("invariants (fast-check)", () => {
  it("at most one status emoji; ✅ only with 🟢 or 🟡 and only after merged; ops converge", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        let state = INITIAL_PR_STATUS;
        let sawMerged = false;
        // Placed reactions when every op is applied in order (the outbox fully drained).
        const placed = new Set<ReactionEmoji>();
        for (const event of events) {
          const result = applyStatusEvent(state, event);
          if (!result.ok) {
            expect(result.error.kind).toBe("conflict");
            continue;
          }
          const { state: next, ops } = result.value;
          if (event.type === "merged" && next.merged) sawMerged = true;

          // Removes strictly before adds.
          const firstAdd = ops.findIndex((o) => o.action === "add");
          if (firstAdd >= 0)
            expect(ops.slice(firstAdd).every((o) => o.action === "add")).toBe(true);

          // Every intermediate placed set is valid, not only the final one.
          for (const op of ops) {
            apply(placed, op);
            expect(isValidReactionSet(placed)).toBe(true);
            expect(op.seq).toBe(next.seq);
            expect(op.reviewId).toBe(next.reviewId);
          }
          expect([...placed].toSorted()).toEqual([...targetReactions(next)].toSorted());

          // Sequence numbers increase exactly when something changed.
          if (ops.length) expect(next.seq).toBe(state.seq + 1);
          else expect(next.seq).toBe(state.seq);

          const target = targetReactions(next);
          expect(target.filter((e) => e !== MERGED).length).toBeLessThanOrEqual(1);
          if (target.includes(MERGED)) {
            expect(sawMerged).toBe(true);
            expect(target.includes(PASSED) || target.includes(FORCE_APPROVED)).toBe(true);
          }
          state = next;
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("an outbox that drains partially and supersedes stale ops via convergeOps still converges", () => {
    // Each step is an event, followed by draining 0..n pending ops.
    const stepArb = fc.tuple(eventArb, fc.nat({ max: 3 }));
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 40 }), (steps) => {
        let state = INITIAL_PR_STATUS;
        const placed = new Set<ReactionEmoji>();
        let pending: ReactionOp[] = [];
        for (const [event, drain] of steps) {
          const result = applyStatusEvent(state, event);
          if (result.ok && result.value.state.seq !== state.seq) {
            state = result.value.state;
            // A newer target supersedes everything pending: all of it is stale now.
            expect(pending.every((op) => isStaleOp(op, state.seq))).toBe(true);
            pending = convergeOps(placed, state);
          }
          for (let i = 0; i < drain && pending.length; i++) {
            apply(placed, pending.shift()!);
            expect(isValidReactionSet(placed)).toBe(true);
          }
        }
        while (pending.length) {
          apply(placed, pending.shift()!);
          expect(isValidReactionSet(placed)).toBe(true);
        }
        expect([...placed].toSorted()).toEqual([...targetReactions(state)].toSorted());
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("convergeOps from any valid placed set keeps every intermediate set valid and reaches the target", () => {
    const placedArb = fc
      .subarray([PENDING, PASSED, CHANGES, FORCE_APPROVED, MERGED] as ReactionEmoji[])
      .filter(isValidReactionSet);
    const stateArb = fc.array(eventArb, { maxLength: 20 }).map((events) => {
      let state = INITIAL_PR_STATUS;
      for (const e of events) {
        const r = applyStatusEvent(state, e);
        if (r.ok) state = r.value.state;
      }
      return state;
    });
    fc.assert(
      fc.property(placedArb, stateArb, (initial, state) => {
        const placed = new Set(initial);
        for (const op of convergeOps(placed, state)) {
          apply(placed, op);
          expect(isValidReactionSet(placed)).toBe(true);
        }
        expect([...placed].toSorted()).toEqual([...targetReactions(state)].toSorted());
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("rejected events never change the state", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), eventArb, (prefix, event) => {
        let state = INITIAL_PR_STATUS;
        for (const e of prefix) {
          const r = applyStatusEvent(state, e);
          if (r.ok) state = r.value.state;
        }
        const frozen = structuredClone(state);
        applyStatusEvent(state, event);
        expect(state).toEqual(frozen);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});
