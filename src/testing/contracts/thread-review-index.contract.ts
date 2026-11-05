import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordThreadReview, ThreadReviewIndex } from "../../ports/thread-review-index";
import type { ContractHarness, MakeHarness } from "./harness";

const PR1 = "https://github.com/acme/web/pull/1";
const PR2 = "https://github.com/acme/web/pull/2";
const KEY = { channel: "C0REVIEW", threadTs: "1730000000.000100" };

const aThreadReview = (over: Partial<RecordThreadReview> = {}): RecordThreadReview => ({
  ...KEY,
  prUrls: [PR1],
  requesterSlackId: "U0ALICE",
  reviewId: "rv-1",
  ...over,
});

/** The harness clock starts wherever; `advance` moves it. Timestamps are compared relatively. */
export function threadReviewIndexContract(make: MakeHarness<ThreadReviewIndex>) {
  describe("ThreadReviewIndex contract", () => {
    let h: ContractHarness<ThreadReviewIndex>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    const recordOk = async (input: RecordThreadReview) => {
      const r = await h.impl.recordReview(input);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };

    it("creates the thread at seq 1 and reads it back", async () => {
      const created = await recordOk(aThreadReview({ statusMessageTs: "1730000000.000200" }));
      expect(created).toEqual({
        ...KEY,
        prUrls: [PR1],
        requesterSlackId: "U0ALICE",
        latestReviewId: "rv-1",
        reviewSeq: 1,
        statusMessageTs: "1730000000.000200",
        createdAt: expect.any(Date),
        updatedAt: created.createdAt,
      });
      expect(await h.impl.get(KEY)).toEqual(created);
      expect(await h.impl.get({ ...KEY, threadTs: "1730000000.000999" })).toBeNull();
    });

    it("a later review bumps seq, unions PRs, keeps the requester and the status message", async () => {
      const first = await recordOk(aThreadReview({ statusMessageTs: "1730000000.000200" }));
      await h.advance(1000);
      const second = await recordOk(
        aThreadReview({ prUrls: [PR2, PR1], requesterSlackId: "U0OWNER", reviewId: "rv-2" }),
      );
      expect(second).toMatchObject({
        prUrls: [PR1, PR2],
        requesterSlackId: "U0ALICE",
        latestReviewId: "rv-2",
        reviewSeq: 2,
        statusMessageTs: "1730000000.000200",
        createdAt: first.createdAt,
      });
      expect(second.updatedAt.getTime()).toBe(first.createdAt.getTime() + 1000);
    });

    it("concurrent reviews of one thread get distinct, gap-free seqs", async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => recordOk(aThreadReview({ reviewId: `rv-${i}` }))),
      );
      expect(results.map((r) => r.reviewSeq).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
      const stored = await h.impl.get(KEY);
      expect(stored?.reviewSeq).toBe(6);
      expect(stored?.latestReviewId).toBe(results.find((r) => r.reviewSeq === 6)?.latestReviewId);
    });

    it("sets the status message; unknown thread is not_found", async () => {
      await recordOk(aThreadReview());
      const r = await h.impl.setStatusMessage(KEY, "1730000000.000300");
      expect(r.ok && r.value.statusMessageTs).toBe("1730000000.000300");
      expect(r.ok && r.value.reviewSeq).toBe(1);
      expect(
        await h.impl.setStatusMessage({ ...KEY, channel: "C0OTHER" }, "1730000000.000300"),
      ).toEqual({ ok: false, error: { kind: "not_found", entity: "slack_review_thread" } });
    });

    it.each([
      ["channel", { channel: "general" }],
      ["threadTs", { threadTs: "1730000000" }],
      ["prUrls", { prUrls: [] }],
      ["prUrls", { prUrls: ["http://evil"] }],
      ["requesterSlackId", { requesterSlackId: "alice" }],
      ["reviewId", { reviewId: "" }],
      ["statusMessageTs", { statusMessageTs: "x" }],
    ])("rejects invalid %s and stores nothing", async (field, over) => {
      expect(await h.impl.recordReview(aThreadReview(over))).toEqual({
        ok: false,
        error: { kind: "validation", field, message: expect.any(String) },
      });
      expect(await h.impl.get(KEY)).toBeNull();
    });

    it("rejects an invalid key on reads and status updates", async () => {
      expect(await h.impl.get({ channel: "x'; --", threadTs: KEY.threadTs })).toBeNull();
      const r = await h.impl.setStatusMessage(KEY, "nope");
      expect(r).toEqual({
        ok: false,
        error: { kind: "validation", field: "statusMessageTs", message: expect.any(String) },
      });
    });
  });
}
