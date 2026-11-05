import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHANGES,
  FORCE_APPROVED,
  isValidReactionSet,
  MERGED,
  PASSED,
  PENDING,
  type PrStatusState,
  type StatusEmoji,
} from "../../domain/slack/status-emoji";
import type {
  OutboxOp,
  ReactionOutbox,
  ReactionRetryPolicy,
  ReactionTarget,
} from "../../ports/reaction-outbox";
import type { ContractHarness, MakeHarness } from "./harness";

/** Every implementation under this contract is built with this policy. */
export const CONTRACT_REACTION_RETRY: ReactionRetryPolicy = {
  baseMs: 1000,
  maxMs: 8000,
  maxAttempts: 3,
  jitter: () => 0,
};

const CH = "C0REVIEW";
const TS = "1730000000.000200";
const LEASE = 10_000;

const st = (seq: number, status: StatusEmoji | null, merged = false): PrStatusState => ({
  status,
  merged,
  seq,
  reviewId: `rv-${seq}`,
});

const aTarget = (state: PrStatusState, over: Partial<ReactionTarget> = {}): ReactionTarget => ({
  channel: CH,
  ts: TS,
  prUrl: "https://github.com/acme/web/pull/1",
  state,
  ...over,
});

const brief = (ops: OutboxOp[]) => ops.map((o) => `${o.op} ${o.emoji} ${o.state} s${o.seq}`);

export function reactionOutboxContract(make: MakeHarness<ReactionOutbox>) {
  describe("ReactionOutbox contract", () => {
    let h: ContractHarness<ReactionOutbox>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    const enqueue = async (t: ReactionTarget) => {
      const r = await h.impl.enqueue(t);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };
    const enqueuedOps = async (t: ReactionTarget) => {
      const out = await enqueue(t);
      if (out.status !== "enqueued") throw new Error(`expected enqueued, got ${out.status}`);
      return brief(out.ops);
    };
    const claim = (owner = "w1", limit = 10) => h.impl.claimDue({ owner, leaseMs: LEASE, limit });
    /** Claims and completes everything due, as the drainer would. */
    const drain = async () => {
      for (let i = 0; i < 20; i++) {
        const ops = await claim();
        if (ops.length === 0) return;
        for (const op of ops) expect(await h.impl.markDone(op.id, "w1")).toBe(true);
      }
      throw new Error("drain did not settle");
    };
    const messageOps = () => h.impl.listForMessage(CH, TS);
    const current = () => h.impl.currentReactions(CH, TS);

    it("enqueues adds for an untouched message; done ops become the current reactions", async () => {
      const out = await enqueue(aTarget(st(1, PENDING)));
      expect(out.status).toBe("enqueued");
      if (out.status !== "enqueued") return;
      expect(out.superseded).toBe(0);
      expect(brief(out.ops)).toEqual([`add ${PENDING} pending s1`]);
      expect(out.ops[0]).toMatchObject({ channel: CH, ts: TS, reviewId: "rv-1", attempts: 0 });
      const [claimed] = await claim();
      expect(claimed).toMatchObject({
        id: out.ops[0]!.id,
        state: "running",
        leaseOwner: "w1",
        attempts: 1,
      });
      expect(await h.impl.markDone(claimed!.id, "w1")).toBe(true);
      expect(await current()).toEqual([PENDING]);
      expect(brief(await messageOps())).toEqual([`add ${PENDING} done s1`]);
    });

    it("an errored review (no status) on an untouched message enqueues nothing", async () => {
      expect(await enqueue(aTarget(st(1, null)))).toEqual({
        status: "enqueued",
        ops: [],
        superseded: 0,
      });
    });

    it("removes before adds, one op per message at a time, in order", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      await drain();
      expect(await enqueuedOps(aTarget(st(2, PASSED)))).toEqual([
        `remove ${PENDING} pending s2`,
        `add ${PASSED} pending s2`,
      ]);
      const first = await claim();
      expect(brief(first)).toEqual([`remove ${PENDING} running s2`]);
      expect(await claim("w2")).toEqual([]);
      expect(await h.impl.markDone(first[0]!.id, "w1")).toBe(true);
      expect(brief(await claim())).toEqual([`add ${PASSED} running s2`]);
    });

    it("✅ is added last and removed first", async () => {
      await enqueue(aTarget(st(1, PASSED)));
      await drain();
      expect(await enqueuedOps(aTarget(st(2, PASSED, true)))).toEqual([`add ${MERGED} pending s2`]);
      await drain();
      expect(await current()).toEqual([MERGED, PASSED].toSorted());
      expect(await enqueuedOps(aTarget(st(3, PENDING)))).toEqual([
        `remove ${MERGED} pending s3`,
        `remove ${PASSED} pending s3`,
        `add ${PENDING} pending s3`,
      ]);
    });

    it("a failed first remove is retried with backoff and leaves exactly one status emoji (FR-SLACK-14 AC 4-5)", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      await drain();
      await enqueue(aTarget(st(2, PASSED)));
      const [remove] = await claim();
      expect(await h.impl.markFailed(remove!.id, "w1")).toEqual({
        state: "pending",
        nextAttemptAt: expect.any(Date),
      });
      // The add waits behind the failed remove: nothing is due yet.
      expect(await claim()).toEqual([]);
      await h.advance(999);
      expect(await claim()).toEqual([]);
      await h.advance(1);
      const retried = await claim();
      expect(brief(retried)).toEqual([`remove ${PENDING} running s2`]);
      expect(retried[0]!.attempts).toBe(2);
      expect(await h.impl.markDone(retried[0]!.id, "w1")).toBe(true);
      await drain();
      expect(await current()).toEqual([PASSED]);
    });

    it("a newer seq drops older pending ops and reconverges from what is placed (no two status emoji)", async () => {
      // ⏳ is on the message; the 🟢 swap is pending when force-approve-like churn arrives.
      await enqueue(aTarget(st(1, PENDING)));
      await drain();
      await enqueue(aTarget(st(2, CHANGES)));
      // The remove of ⏳ landed, the add of 🔴 did not yet.
      const [removePending] = await claim();
      expect(await h.impl.markDone(removePending!.id, "w1")).toBe(true);
      const out = await enqueue(aTarget(st(3, FORCE_APPROVED)));
      expect(out).toMatchObject({ status: "enqueued", superseded: 1 });
      // Dropping alone would leave nothing to place 🟡; converging from `placed` (empty) adds it.
      expect(brief(await messageOps())).toEqual([
        `add ${PENDING} done s1`,
        `remove ${PENDING} done s2`,
        `add ${CHANGES} superseded s2`,
        `add ${FORCE_APPROVED} pending s3`,
      ]);
      await drain();
      expect(await current()).toEqual([FORCE_APPROVED]);
    });

    it("after a dropped swap, the new ops remove the still-placed old status", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      await drain();
      await enqueue(aTarget(st(2, PASSED))); // remove ⏳, add 🟢: both pending
      expect(await enqueuedOps(aTarget(st(3, CHANGES)))).toEqual([
        `remove ${PENDING} pending s3`,
        `add ${CHANGES} pending s3`,
      ]);
      await drain();
      const now = await current();
      expect(now).toEqual([CHANGES]);
      expect(isValidReactionSet(now)).toBe(true);
    });

    it("an older seq is stale and an equal seq is a duplicate; neither changes anything", async () => {
      await enqueue(aTarget(st(2, PASSED)));
      expect(await enqueue(aTarget(st(1, PENDING)))).toEqual({ status: "stale", latestSeq: 2 });
      expect(await enqueue(aTarget(st(2, PASSED)))).toEqual({ status: "duplicate", latestSeq: 2 });
      expect(brief(await messageOps())).toEqual([`add ${PASSED} pending s2`]);
    });

    it("counts an add still in flight: the next state removes what it may place", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      const [inFlightAdd] = await claim();
      expect(await enqueuedOps(aTarget(st(2, CHANGES)))).toEqual([
        `remove ${PENDING} pending s2`,
        `add ${CHANGES} pending s2`,
      ]);
      expect(await claim("w2")).toEqual([]);
      expect(await h.impl.markDone(inFlightAdd!.id, "w1")).toBe(true);
      await drain();
      expect(await current()).toEqual([CHANGES]);
    });

    it("counts a remove still in flight: the next state re-adds what it may take away", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      await drain();
      await enqueue(aTarget(st(2, null)));
      const [inFlightRemove] = await claim();
      expect(await enqueuedOps(aTarget(st(3, PENDING)))).toEqual([`add ${PENDING} pending s3`]);
      expect(await h.impl.markDone(inFlightRemove!.id, "w1")).toBe(true);
      await drain();
      expect(await current()).toEqual([PENDING]);
    });

    it("backoff doubles per attempt and honours Retry-After", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      const [op] = await claim();
      const t0 = (await messageOps())[0]!.nextAttemptAt.getTime();
      const f1 = await h.impl.markFailed(op!.id, "w1", { retryAfterMs: 5000 });
      expect(f1?.state === "pending" && f1.nextAttemptAt.getTime() - t0).toBe(5000);
      await h.advance(5000);
      const [op2] = await claim();
      const f2 = await h.impl.markFailed(op2!.id, "w1");
      expect(f2?.state === "pending" && f2.nextAttemptAt.getTime() - t0).toBe(5000 + 2000);
    });

    it("fails an op after maxAttempts or a permanent error; a failed op no longer blocks its message", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      await drain();
      await enqueue(aTarget(st(2, PASSED)));
      for (let attempt = 1; attempt <= 2; attempt++) {
        const [op] = await claim();
        expect((await h.impl.markFailed(op!.id, "w1"))?.state).toBe("pending");
        await h.advance(10_000);
      }
      const [last] = await claim();
      expect(await h.impl.markFailed(last!.id, "w1")).toEqual({ state: "failed" });
      const [add] = await claim();
      expect(add).toMatchObject({ op: "add", emoji: PASSED });
      expect(await h.impl.markFailed(add!.id, "w1", { permanent: true })).toEqual({
        state: "failed",
      });
      // The failed remove left ⏳ in place, so the next state removes it again.
      expect(await enqueuedOps(aTarget(st(3, CHANGES)))).toEqual([
        `remove ${PENDING} pending s3`,
        `add ${CHANGES} pending s3`,
      ]);
    });

    it("an expired lease is reclaimable; the old owner can no longer finish the op", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      const [op] = await claim("w1");
      expect(await claim("w2")).toEqual([]);
      await h.advance(LEASE + 1);
      const [again] = await claim("w2");
      expect(again).toMatchObject({ id: op!.id, leaseOwner: "w2", attempts: 2 });
      expect(await h.impl.markDone(op!.id, "w1")).toBe(false);
      expect(await h.impl.markFailed(op!.id, "w1")).toBeNull();
      expect(await h.impl.markDone(op!.id, "w2")).toBe(true);
      expect(await h.impl.markDone(op!.id, "w2")).toBe(false);
    });

    it("claims across messages, one op each, never the same op twice under concurrency", async () => {
      const ts = (i: number) => `1730000000.00030${i}`;
      for (let i = 0; i < 4; i++) await enqueue(aTarget(st(1, PASSED), { ts: ts(i) }));
      await drain();
      for (let i = 0; i < 4; i++) await enqueue(aTarget(st(2, PENDING), { ts: ts(i) }));
      const batches = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          h.impl.claimDue({ owner: `w${i}`, leaseMs: LEASE, limit: 2 }),
        ),
      );
      const claimed = batches.flat();
      expect(new Set(claimed.map((o) => o.id)).size).toBe(claimed.length);
      expect(claimed).toHaveLength(4);
      expect(new Set(claimed.map((o) => o.ts)).size).toBe(4);
      expect(claimed.every((o) => o.op === "remove")).toBe(true);
    });

    it("concurrent enqueues for one message leave only the newest seq pending", async () => {
      const statuses = [PENDING, PASSED, CHANGES, FORCE_APPROVED, PENDING] as const;
      const outs = await Promise.all(statuses.map((s, i) => h.impl.enqueue(aTarget(st(i + 1, s)))));
      expect(outs.every((o) => o.ok)).toBe(true);
      const pending = (await messageOps()).filter((o) => o.state === "pending");
      expect(brief(pending)).toEqual([`add ${PENDING} pending s5`]);
    });

    it("retention deletes finished ops but keeps the latest seq, so stale checks still hold", async () => {
      await enqueue(aTarget(st(1, PENDING)));
      await drain();
      await enqueue(aTarget(st(2, PASSED)));
      await enqueue(aTarget(st(3, CHANGES)));
      await drain();
      await h.advance(1000);
      expect(await h.impl.deleteFinishedBefore(new Date(Date.now() + 365 * 86_400_000))).toBe(3);
      expect(brief(await messageOps())).toEqual([
        `remove ${PENDING} done s3`,
        `add ${CHANGES} done s3`,
      ]);
      expect(await current()).toEqual([CHANGES]);
      expect(await enqueue(aTarget(st(2, PASSED)))).toEqual({ status: "stale", latestSeq: 3 });
    });

    it.each([
      ["channel", { channel: "general" }],
      ["ts", { ts: "17300" }],
      ["prUrl", { prUrl: "ftp://x" }],
      ["state.seq", { state: { ...st(1, PENDING), seq: -1 } }],
      ["state.reviewId", { state: { ...st(1, PENDING), reviewId: "" } }],
      ["state.status", { state: { ...st(1, PENDING), status: "fire" as never } }],
      ["state.merged", { state: st(1, CHANGES, true) }],
    ])("rejects an invalid %s and stores nothing", async (field, over) => {
      expect(
        await h.impl.enqueue(aTarget(st(1, PENDING), over as Partial<ReactionTarget>)),
      ).toEqual({ ok: false, error: { kind: "validation", field, message: expect.any(String) } });
      expect(await messageOps()).toEqual([]);
    });

    it("rejects invalid claim options", async () => {
      await expect(h.impl.claimDue({ owner: "", leaseMs: LEASE, limit: 1 })).rejects.toThrow();
      await expect(h.impl.claimDue({ owner: "w", leaseMs: 0, limit: 1 })).rejects.toThrow();
      await expect(h.impl.claimDue({ owner: "w", leaseMs: LEASE, limit: 0 })).rejects.toThrow();
    });
  });
}
