import { describe, expect, it } from "vitest";
import { MAX_INTERRUPTIONS, step } from "../../domain/review-queue/state-machine";
import type { ReviewJobRepo } from "../../ports/review-job-repo";
import { aNewReviewJob } from "../builders/review-job";

export type ReviewJobRepoHarness = {
  repo: ReviewJobRepo;
  /** Moves time forward: fakes advance a FakeClock, real adapters may sleep. */
  advance(ms: number): Promise<void> | void;
  cleanup(): Promise<void>;
};

const LEASE = 10_000;

async function seed(h: ReviewJobRepoHarness, ids: string[]) {
  for (const id of ids) {
    const r = await h.repo.create(aNewReviewJob({ id }));
    expect(r.ok).toBe(true);
    await h.advance(1);
  }
}

export function reviewJobRepoContract(make: () => Promise<ReviewJobRepoHarness>) {
  async function withRepo(fn: (h: ReviewJobRepoHarness) => Promise<void>) {
    const h = await make();
    try {
      await fn(h);
    } finally {
      await h.cleanup();
    }
  }

  describe("ReviewJobRepo contract", () => {
    it("create then get round-trips; duplicate id conflicts", () =>
      withRepo(async ({ repo }) => {
        const created = await repo.create(aNewReviewJob({ id: "a" }));
        if (!created.ok) throw new Error("create failed");
        expect(created.value).toMatchObject({
          id: "a",
          state: "queued",
          attempts: 0,
          version: 1,
          leaseOwner: null,
          leaseUntil: null,
          nextAttemptAt: null,
        });
        expect(await repo.get("a")).toEqual(created.value);
        expect(await repo.get("missing")).toBeNull();
        const dup = await repo.create(aNewReviewJob({ id: "a" }));
        expect(dup).toEqual({ ok: false, error: { kind: "conflict", reason: expect.any(String) } });
      }));

    it("claims oldest first", () =>
      withRepo(async (h) => {
        await seed(h, ["j1", "j2", "j3"]);
        const ids = [
          (await h.repo.claimNext({ owner: "w", leaseMs: LEASE }))?.id,
          (await h.repo.claimNext({ owner: "w", leaseMs: LEASE }))?.id,
          (await h.repo.claimNext({ owner: "w", leaseMs: LEASE }))?.id,
        ];
        expect(ids).toEqual(["j1", "j2", "j3"]);
        expect(await h.repo.claimNext({ owner: "w", leaseMs: LEASE })).toBeNull();
      }));

    it("claim sets running, lease, attempts and version", () =>
      withRepo(async (h) => {
        await seed(h, ["a"]);
        const job = await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        expect(job).toMatchObject({
          id: "a",
          state: "running",
          leaseOwner: "w1",
          attempts: 1,
          version: 2,
        });
        expect(job?.leaseUntil).toBeInstanceOf(Date);
      }));

    it("does not claim a future nextAttemptAt until it passes", () =>
      withRepo(async (h) => {
        // Derive the future time from the repo's own clock via a probe row.
        const probe = await h.repo.create(aNewReviewJob({ id: "probe", state: "done" }));
        if (!probe.ok) throw new Error("create failed");
        const future = new Date(probe.value.createdAt.getTime() + 5_000);
        await h.repo.create(aNewReviewJob({ id: "later", nextAttemptAt: future }));
        expect(await h.repo.claimNext({ owner: "w", leaseMs: LEASE })).toBeNull();
        await h.advance(5_001);
        expect((await h.repo.claimNext({ owner: "w", leaseMs: LEASE }))?.id).toBe("later");
      }));

    it("20 concurrent claims over 5 jobs yield 5 distinct jobs and 15 nulls", () =>
      withRepo(async (h) => {
        await seed(h, ["a", "b", "c", "d", "e"]);
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            h.repo.claimNext({ owner: `w${i}`, leaseMs: LEASE }),
          ),
        );
        const claimed = results.filter((r) => r !== null);
        expect(claimed).toHaveLength(5);
        expect(new Set(claimed.map((j) => j?.id)).size).toBe(5);
        expect(results.filter((r) => r === null)).toHaveLength(15);
      }));

    it("reclaims an expired lease for a new owner and increments attempts", () =>
      withRepo(async (h) => {
        await seed(h, ["a"]);
        const first = await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        expect(first?.attempts).toBe(1);
        expect(await h.repo.claimNext({ owner: "w2", leaseMs: LEASE })).toBeNull();
        await h.advance(LEASE + 1);
        const second = await h.repo.claimNext({ owner: "w2", leaseMs: LEASE });
        expect(second).toMatchObject({ id: "a", leaseOwner: "w2", attempts: 2, state: "running" });
      }));

    it("a lease-expired reclaim counts as one interruption; a queued claim does not", () =>
      withRepo(async (h) => {
        await h.repo.create(aNewReviewJob({ id: "a", interruptions: 1 }));
        const first = await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        expect(first?.interruptions).toBe(1);
        await h.advance(LEASE + 1);
        const second = await h.repo.claimNext({ owner: "w2", leaseMs: LEASE });
        expect(second).toMatchObject({ state: "running", leaseOwner: "w2", interruptions: 2 });
        expect((await h.repo.get("a"))?.interruptions).toBe(2);
      }));

    it("the third lease-expired reclaim exhausts the job, and the domain fails it", () =>
      withRepo(async (h) => {
        await seed(h, ["a"]);
        const first = await h.repo.claimNext({ owner: "w0", leaseMs: LEASE });
        if (!first) throw new Error("no job");
        expect(first.interruptions ?? 0).toBe(0);
        let job = first;
        for (let n = 1; n <= MAX_INTERRUPTIONS; n += 1) {
          await h.advance(LEASE + 1);
          const reclaimed = await h.repo.claimNext({ owner: `w${n}`, leaseMs: LEASE });
          if (!reclaimed) throw new Error(`reclaim ${n} returned null`);
          expect(reclaimed).toMatchObject({ interruptions: n, attempts: n + 1 });
          // A reclaim continues the same run.
          expect(reclaimed.runStartedAt).toEqual(first.runStartedAt);
          job = reclaimed;
        }
        const out = step(job, { type: "interruption_limit" }, job.updatedAt);
        if (!out.ok) throw new Error(`interruption_limit rejected: ${out.error.kind}`);
        expect(out.value.records.map((r) => r.failure)).toEqual(["interrupted"]);
        const saved = await h.repo.save(out.value.job, {
          expectedVersion: job.version,
          owner: job.leaseOwner ?? undefined,
        });
        if (!saved.ok) throw new Error("save failed");
        expect(await h.repo.get("a")).toMatchObject({
          state: "failed",
          interruptions: MAX_INTERRUPTIONS,
          leaseOwner: null,
        });
        await h.advance(LEASE * 10);
        expect(await h.repo.claimNext({ owner: "w9", leaseMs: LEASE })).toBeNull();
      }));

    it("never claims done or failed jobs", () =>
      withRepo(async (h) => {
        await h.repo.create(aNewReviewJob({ id: "d", state: "done" }));
        await h.repo.create(aNewReviewJob({ id: "f", state: "failed" }));
        await h.advance(LEASE * 10);
        expect(await h.repo.claimNext({ owner: "w", leaseMs: LEASE })).toBeNull();
      }));

    it("runStartedAt round-trips through create, save and get, and can be cleared", () =>
      withRepo(async (h) => {
        const startedAt = new Date("2026-03-04T05:06:07.089Z");
        const created = await h.repo.create(aNewReviewJob({ id: "a", runStartedAt: startedAt }));
        if (!created.ok) throw new Error("create failed");
        expect(created.value.runStartedAt).toEqual(startedAt);
        expect(await h.repo.get("a")).toEqual(created.value);

        const later = new Date("2026-03-04T06:00:00.000Z");
        const saved = await h.repo.save(
          { ...created.value, runStartedAt: later },
          { expectedVersion: created.value.version },
        );
        if (!saved.ok) throw new Error("save failed");
        expect((await h.repo.get("a"))?.runStartedAt).toEqual(later);

        const { runStartedAt: _drop, ...cleared } = saved.value;
        const reset = await h.repo.save(cleared, { expectedVersion: saved.value.version });
        if (!reset.ok) throw new Error("save failed");
        const fresh = await h.repo.get("a");
        expect(fresh).not.toHaveProperty("runStartedAt");
        expect(fresh).toEqual(reset.value);
      }));

    it("a job created without runStartedAt has no runStartedAt key", () =>
      withRepo(async ({ repo }) => {
        const created = await repo.create(aNewReviewJob({ id: "a" }));
        if (!created.ok) throw new Error("create failed");
        expect(created.value).not.toHaveProperty("runStartedAt");
        expect(await repo.get("a")).not.toHaveProperty("runStartedAt");
      }));

    it("the first claim of a run sets runStartedAt; a lease reclaim keeps it", () =>
      withRepo(async (h) => {
        await seed(h, ["a"]);
        const first = await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        if (!first) throw new Error("no job");
        expect(first.runStartedAt).toEqual(first.updatedAt);
        expect((await h.repo.get("a"))?.runStartedAt).toEqual(first.updatedAt);
        await h.advance(LEASE + 1);
        const second = await h.repo.claimNext({ owner: "w2", leaseMs: LEASE });
        expect(second?.runStartedAt).toEqual(first.runStartedAt);
        expect(second?.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
      }));

    it("claiming keeps a runStartedAt the job already carries", () =>
      withRepo(async (h) => {
        const startedAt = new Date("2025-12-31T23:00:00.000Z");
        await h.repo.create(aNewReviewJob({ id: "a", runStartedAt: startedAt }));
        const claimed = await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        expect(claimed?.runStartedAt).toEqual(startedAt);
      }));

    it("per-URL reviewSeq, approve and recorded progress round-trip", () =>
      withRepo(async (h) => {
        const url = "https://github.com/acme/app/pull/1";
        const other = "https://github.com/acme/app/pull/2";
        const progress = {
          [url]: {
            reviewed: true,
            completed: true,
            reviewSeq: 7,
            approve: { step: "approved" as const, sha: "abc123", githubReviewId: 42 },
            recorded: true,
          },
          [other]: {
            reviewSeq: 0,
            approve: { step: "approve_pending" as const, sha: "def456" },
          },
        };
        const created = await h.repo.create(
          aNewReviewJob({ id: "a", urls: [url, other], progress }),
        );
        if (!created.ok) throw new Error("create failed");
        expect((await h.repo.get("a"))?.progress).toEqual(progress);

        const next = {
          ...progress,
          [other]: {
            reviewSeq: 0,
            approve: { step: "approve_skipped" as const, sha: "def456", reason: "P1 finding" },
            recorded: false,
          },
        };
        const saved = await h.repo.save(
          { ...created.value, progress: next },
          { expectedVersion: created.value.version },
        );
        if (!saved.ok) throw new Error("save failed");
        expect(saved.value.progress).toEqual(next);
        expect((await h.repo.get("a"))?.progress).toEqual(next);
      }));

    it("extendLease: owner extends, non-owner and expired lease get false", () =>
      withRepo(async (h) => {
        await seed(h, ["a"]);
        await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        expect(await h.repo.extendLease("a", "w2", LEASE)).toBe(false);
        expect(await h.repo.extendLease("nope", "w1", LEASE)).toBe(false);
        await h.advance(LEASE - 1);
        expect(await h.repo.extendLease("a", "w1", LEASE)).toBe(true);
        await h.advance(LEASE - 1);
        // Still held thanks to the extension: nobody else can claim it.
        expect(await h.repo.claimNext({ owner: "w2", leaseMs: LEASE })).toBeNull();
        await h.advance(LEASE + 1);
        expect(await h.repo.extendLease("a", "w1", LEASE)).toBe(false);
      }));

    it("save with a stale version conflicts", () =>
      withRepo(async (h) => {
        await seed(h, ["a"]);
        const job = await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        if (!job) throw new Error("no job");
        const res = await h.repo.save(job, { expectedVersion: job.version - 1 });
        expect(res).toMatchObject({ ok: false, error: { kind: "conflict" } });
        expect((await h.repo.get("a"))?.version).toBe(job.version);
      }));

    it("save increments version and persists changes", () =>
      withRepo(async (h) => {
        await seed(h, ["a"]);
        const job = await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        if (!job) throw new Error("no job");
        const res = await h.repo.save(
          {
            ...job,
            state: "done",
            progress: { u: { reviewed: true } },
            leaseOwner: null,
            leaseUntil: null,
          },
          { expectedVersion: job.version, owner: "w1" },
        );
        if (!res.ok) throw new Error("save failed");
        expect(res.value.version).toBe(job.version + 1);
        expect(res.value.updatedAt.getTime()).toBeGreaterThanOrEqual(job.updatedAt.getTime());
        expect(await h.repo.get("a")).toMatchObject({
          state: "done",
          progress: { u: { reviewed: true } },
          version: job.version + 1,
        });
      }));

    it("save by an owner whose lease expired conflicts, even with the right version", () =>
      withRepo(async (h) => {
        await seed(h, ["a"]);
        const job = await h.repo.claimNext({ owner: "w1", leaseMs: LEASE });
        if (!job) throw new Error("no job");
        await h.advance(LEASE + 1);
        const stale = await h.repo.save(
          { ...job, state: "done" },
          { expectedVersion: job.version, owner: "w1" },
        );
        expect(stale).toMatchObject({ ok: false, error: { kind: "conflict" } });
        // A different owner reclaims; the old owner stays fenced out.
        const taken = await h.repo.claimNext({ owner: "w2", leaseMs: LEASE });
        expect(taken?.leaseOwner).toBe("w2");
        const fenced = await h.repo.save(
          { ...job, state: "done" },
          { expectedVersion: taken?.version ?? 0, owner: "w1" },
        );
        expect(fenced).toMatchObject({ ok: false, error: { kind: "conflict" } });
        expect((await h.repo.get("a"))?.state).toBe("running");
      }));

    it("listRecent returns newest first and honours limit", () =>
      withRepo(async (h) => {
        await seed(h, ["j1", "j2", "j3"]);
        expect((await h.repo.listRecent({ limit: 10 })).map((j) => j.id)).toEqual([
          "j3",
          "j2",
          "j1",
        ]);
        expect((await h.repo.listRecent({ limit: 2 })).map((j) => j.id)).toEqual(["j3", "j2"]);
      }));

    it("deleteFinishedBefore deletes only old done/failed jobs", () =>
      withRepo(async (h) => {
        await h.repo.create(aNewReviewJob({ id: "old-done", state: "done" }));
        await h.repo.create(aNewReviewJob({ id: "old-failed", state: "failed" }));
        await h.repo.create(aNewReviewJob({ id: "old-queued", state: "queued" }));
        await h.advance(1_000);
        const cutoff = (await h.repo.get("old-done"))?.updatedAt;
        if (!cutoff) throw new Error("missing");
        await h.advance(1_000);
        await h.repo.create(aNewReviewJob({ id: "new-done", state: "done" }));
        const cutoffPlus = new Date(cutoff.getTime() + 1_500);
        expect(await h.repo.deleteFinishedBefore(cutoffPlus)).toBe(2);
        expect(await h.repo.get("old-done")).toBeNull();
        expect(await h.repo.get("old-failed")).toBeNull();
        expect(await h.repo.get("old-queued")).not.toBeNull();
        expect(await h.repo.get("new-done")).not.toBeNull();
      }));

    it("returns copies: mutating a result does not change the stored job", () =>
      withRepo(async (h) => {
        const created = await h.repo.create(aNewReviewJob({ id: "a" }));
        if (!created.ok) throw new Error("create failed");
        created.value.urls.push("x");
        created.value.progress.x = { reviewed: true };
        created.value.createdAt.setFullYear(1990);
        const got = await h.repo.get("a");
        got?.urls.push("y");
        got?.createdAt.setFullYear(1991);
        const listed = await h.repo.listRecent({ limit: 1 });
        listed[0]?.urls.push("z");
        const claimed = await h.repo.claimNext({ owner: "w", leaseMs: LEASE });
        claimed?.leaseUntil?.setFullYear(1992);
        claimed?.urls.push("w");
        const fresh = await h.repo.get("a");
        expect(fresh?.urls).toEqual(["https://github.com/acme/app/pull/1"]);
        expect(fresh?.progress).toEqual({});
        expect(fresh?.createdAt.getFullYear()).toBeGreaterThan(2000);
        expect(fresh?.leaseUntil?.getFullYear()).toBeGreaterThan(2000);
      }));
  });
}
