import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewReviewEvent, ReviewEventRepo } from "../../ports/review-event-repo";
import { aRejectedEvent, type ContractHarness, type MakeHarness } from "./harness";

const T0 = Date.parse("2026-11-04T01:00:00.000Z");

const anEvent = (n: number, over: Partial<NewReviewEvent> = {}): NewReviewEvent => ({
  id: `ev-${n}`,
  type: "github_repo_added",
  actor: { kind: "user", id: "owner-1" },
  at: new Date(T0 + n * 1000),
  detail: { repo: `acme/r${n}` },
  ...over,
});

export function reviewEventRepoContract(make: MakeHarness<ReviewEventRepo>) {
  describe("ReviewEventRepo contract", () => {
    let h: ContractHarness<ReviewEventRepo>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("appends and lists newest first, round-tripping every field", async () => {
      const full = anEvent(2, {
        type: "github_token_saved",
        prUrl: "https://github.com/acme/web/pull/1",
        reviewId: "rv-1",
        jobId: "job-1",
        sha: "abc123",
        reason: "why",
        source: "web",
        detail: { login: "octocat", last4: "WXYZ", n: 1, flag: true, none: null },
      });
      expect(await h.impl.append(anEvent(1))).toEqual({ inserted: true });
      expect(await h.impl.append(full)).toEqual({ inserted: true });
      expect(await h.impl.list({ limit: 10 })).toEqual([full, anEvent(1)]);
    });

    it("filters by type and honours the limit", async () => {
      await h.impl.append(anEvent(1));
      await h.impl.append(anEvent(2, { type: "github_token_removed", detail: undefined }));
      await h.impl.append(anEvent(3));
      expect(
        (await h.impl.list({ types: ["github_repo_added"], limit: 10 })).map((e) => e.id),
      ).toEqual(["ev-3", "ev-1"]);
      expect((await h.impl.list({ limit: 2 })).map((e) => e.id)).toEqual(["ev-3", "ev-2"]);
      expect(await h.impl.list({ types: [], limit: 10 })).toEqual([]);
    });

    it("ignores a repeated (jobId, prUrl, type) step, but never dedupes events without a job", async () => {
      const step = { jobId: "job-1", prUrl: "https://github.com/acme/web/pull/1" };
      expect(await h.impl.append(anEvent(1, step))).toEqual({ inserted: true });
      expect(await h.impl.append(anEvent(2, step))).toEqual({ inserted: false });
      expect(await h.impl.append(anEvent(3))).toEqual({ inserted: true });
      expect(await h.impl.append(anEvent(4))).toEqual({ inserted: true });
      expect((await h.impl.list({ limit: 10 })).map((e) => e.id)).toEqual(["ev-4", "ev-3", "ev-1"]);
    });

    it("stores review step events and filters by PR URL and review id (AND)", async () => {
      const pr1 = "https://github.com/acme/web/pull/1";
      const pr2 = "https://github.com/acme/web/pull/2";
      const step = (n: number, over: Partial<NewReviewEvent>) =>
        anEvent(n, { detail: undefined, actor: { kind: "system", id: "auto" }, ...over });
      await h.impl.append(step(1, { type: "review_finished", prUrl: pr1, reviewId: "rv-1" }));
      await h.impl.append(
        step(2, { type: "approved", prUrl: pr1, reviewId: "rv-1", sha: "abc1234" }),
      );
      await h.impl.append(step(3, { type: "review_finished", prUrl: pr2, reviewId: "rv-2" }));
      await h.impl.append(step(4, { type: "merged", prUrl: pr1, reviewId: "rv-3" }));
      const ids = async (f: Parameters<ReviewEventRepo["list"]>[0]) =>
        (await h.impl.list(f)).map((e) => e.id);
      expect(await ids({ prUrl: pr1, limit: 10 })).toEqual(["ev-4", "ev-2", "ev-1"]);
      expect(await ids({ reviewId: "rv-1", limit: 10 })).toEqual(["ev-2", "ev-1"]);
      expect(await ids({ prUrl: pr1, types: ["approved", "merged"], limit: 10 })).toEqual([
        "ev-4",
        "ev-2",
      ]);
      expect(await ids({ prUrl: pr2, reviewId: "rv-1", limit: 10 })).toEqual([]);
      const [approved] = await h.impl.list({ types: ["approved"], limit: 1 });
      expect(approved).toEqual(
        step(2, { type: "approved", prUrl: pr1, reviewId: "rv-1", sha: "abc1234" }),
      );
    });

    it("rejects an event without an actor id and stores nothing (NOT NULL)", async () => {
      await expect(h.impl.append(aRejectedEvent("github_repo_added"))).rejects.toThrow();
      expect(await h.impl.list({ limit: 10 })).toEqual([]);
    });

    it("concurrent appends of the same step insert exactly one", async () => {
      const step = { jobId: "job-9", prUrl: "https://github.com/acme/web/pull/9" };
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => h.impl.append(anEvent(i + 1, step))),
      );
      expect(results.filter((r) => r.inserted)).toHaveLength(1);
    });
  });
}
