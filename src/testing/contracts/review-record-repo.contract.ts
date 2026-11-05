import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewReviewRecord, ReviewRecordRepo } from "../../ports/review-record-repo";
import type { ContractHarness, MakeHarness } from "./harness";

const T0 = Date.parse("2026-11-04T01:00:00.000Z");

export const aReviewRecord = (n: number, over: Partial<NewReviewRecord> = {}): NewReviewRecord => ({
  id: `rr-${n}`,
  jobId: `job-${n}`,
  run: 1,
  prUrl: `https://github.com/acme/web/pull/${n}`,
  owner: "acme",
  repo: "web",
  number: n,
  source: "slack",
  requester: { kind: "slack", id: "U0OWNER" },
  startedAt: new Date(T0 + n * 60_000 - 30_000),
  finishedAt: new Date(T0 + n * 60_000),
  status: "completed",
  verdict: "pass",
  findings: [],
  ...over,
});

export function reviewRecordRepoContract(make: MakeHarness<ReviewRecordRepo>) {
  describe("ReviewRecordRepo contract", () => {
    let h: ContractHarness<ReviewRecordRepo>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    const insertOk = async (r: NewReviewRecord) => {
      const res = await h.impl.insert(r);
      if (!res.ok) throw new Error(`insert failed: ${JSON.stringify(res.error)}`);
      return res.value;
    };

    it("inserts and reads back every field", async () => {
      const full = aReviewRecord(1, {
        headSha: "abc1234def",
        baseSha: "0011223",
        requester: { kind: "user", id: "user-1" },
        source: "web",
        provider: "anthropic",
        model: "claude-x",
        verdict: "changes_requested",
        summary: "一个 P0",
        findings: [
          { severity: "P0", title: "t", body: "b", path: "a.ts", line: 3, titleZh: "标题" },
          { severity: "Nit", title: "n", body: "m" },
        ],
      });
      expect(await insertOk(full)).toEqual({ record: full, inserted: true });
      expect(await h.impl.get("rr-1")).toEqual(full);
      expect(await h.impl.get("missing")).toBeNull();
    });

    it("is idempotent on (jobId, prUrl, run) and returns the stored record", async () => {
      const first = aReviewRecord(1);
      await insertOk(first);
      const again = await insertOk({ ...first, id: "rr-other", verdict: "changes_requested" });
      expect(again).toEqual({ record: first, inserted: false });
      expect(await h.impl.get("rr-other")).toBeNull();
    });

    it("a retried run (run + 1) writes a new record; another PR of the same job too", async () => {
      await insertOk(aReviewRecord(1));
      expect((await insertOk(aReviewRecord(1, { id: "rr-1b", run: 2 }))).inserted).toBe(true);
      const otherPr = aReviewRecord(1, {
        id: "rr-1c",
        prUrl: "https://github.com/acme/web/pull/9",
      });
      expect((await insertOk(otherPr)).inserted).toBe(true);
    });

    it("an id reused for a different run is a conflict", async () => {
      await insertOk(aReviewRecord(1));
      const res = await h.impl.insert(aReviewRecord(2, { id: "rr-1" }));
      expect(res).toEqual({ ok: false, error: { kind: "conflict", reason: expect.any(String) } });
    });

    it("concurrent inserts of the same run store exactly one", async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => h.impl.insert(aReviewRecord(1, { id: `rr-c${i}` }))),
      );
      const values = results.map((r) => (r.ok ? r.value : null));
      expect(values.filter((v) => v?.inserted)).toHaveLength(1);
      const stored = values.find((v) => v?.inserted)!.record;
      for (const v of values) expect(v?.record).toEqual(stored);
    });

    it.each([
      ["id", { id: "" }],
      ["run", { run: 0 }],
      ["prUrl", { prUrl: "javascript:alert(1)" }],
      ["owner", { owner: "a b" }],
      ["number", { number: -1 }],
      ["headSha", { headSha: "not-a-sha" }],
      ["source", { source: "email" as never }],
      ["requester", { requester: { kind: "robot" as never, id: "x" } }],
      ["finishedAt", { finishedAt: new Date(T0 - 3_600_000) }],
      ["verdict", { verdict: undefined }],
      ["errorCategory", { status: "failed" as const, verdict: undefined }],
      ["verdict", { status: "failed" as const, errorCategory: "upstream_llm" }],
      [
        "errorCategory",
        { status: "failed" as const, verdict: undefined, errorCategory: "Boom: x" },
      ],
      ["findings", { findings: [{ severity: "P0" }] as never }],
    ])("rejects invalid %s and stores nothing", async (field, over) => {
      const res = await h.impl.insert(aReviewRecord(1, over as Partial<NewReviewRecord>));
      expect(res).toEqual({
        ok: false,
        error: { kind: "validation", field, message: expect.any(String) },
      });
      expect(await h.impl.get("rr-1")).toBeNull();
    });

    it("records a failed run with an error category and no verdict", async () => {
      const failed = aReviewRecord(1, {
        status: "failed",
        verdict: undefined,
        errorCategory: "upstream_llm",
      });
      expect((await insertOk(failed)).record).toEqual(failed);
    });

    it("latestForPr returns the newest record of that PR", async () => {
      const pr = "https://github.com/acme/web/pull/7";
      await insertOk(aReviewRecord(1, { prUrl: pr, number: 7 }));
      await insertOk(aReviewRecord(3, { prUrl: pr, number: 7 }));
      await insertOk(aReviewRecord(2, { prUrl: pr, number: 7 }));
      expect((await h.impl.latestForPr(pr))?.id).toBe("rr-3");
      expect(await h.impl.latestForPr("https://github.com/acme/web/pull/404")).toBeNull();
    });

    it("lists newest first and pages with a stable cursor while records are appended", async () => {
      for (let n = 1; n <= 5; n++) await insertOk(aReviewRecord(n));
      const p1 = await h.impl.list({ limit: 2 });
      if (!p1.ok) throw new Error("list failed");
      expect(p1.value.items.map((r) => r.id)).toEqual(["rr-5", "rr-4"]);
      expect(p1.value.nextCursor).toEqual(expect.any(String));
      await insertOk(aReviewRecord(6));
      const p2 = await h.impl.list({ limit: 2, cursor: p1.value.nextCursor! });
      if (!p2.ok) throw new Error("list failed");
      expect(p2.value.items.map((r) => r.id)).toEqual(["rr-3", "rr-2"]);
      const p3 = await h.impl.list({ limit: 2, cursor: p2.value.nextCursor! });
      if (!p3.ok) throw new Error("list failed");
      expect(p3.value.items.map((r) => r.id)).toEqual(["rr-1"]);
      expect(p3.value.nextCursor).toBeNull();
    });

    it("breaks finishedAt ties by id descending across pages", async () => {
      const at = new Date(T0 + 600_000);
      for (const n of [1, 2, 3])
        await insertOk(aReviewRecord(n, { startedAt: new Date(T0), finishedAt: at }));
      const p1 = await h.impl.list({ limit: 2 });
      if (!p1.ok) throw new Error("list failed");
      const p2 = await h.impl.list({ limit: 2, cursor: p1.value.nextCursor! });
      if (!p2.ok) throw new Error("list failed");
      expect([...p1.value.items, ...p2.value.items].map((r) => r.id)).toEqual([
        "rr-3",
        "rr-2",
        "rr-1",
      ]);
    });

    it("filters combine with AND: repo (case-insensitive), number, status, source, date range", async () => {
      await insertOk(aReviewRecord(1));
      await insertOk(aReviewRecord(2, { repo: "api", source: "web" }));
      await insertOk(
        aReviewRecord(3, { status: "failed", verdict: undefined, errorCategory: "x" }),
      );
      await insertOk(aReviewRecord(4, { owner: "Other" }));
      const ids = async (q: Parameters<ReviewRecordRepo["list"]>[0]) => {
        const r = await h.impl.list(q);
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return r.value.items.map((x) => x.id);
      };
      expect(await ids({ repo: "ACME/Web" })).toEqual(["rr-3", "rr-1"]);
      expect(await ids({ repo: "acme/web", status: "completed" })).toEqual(["rr-1"]);
      expect(await ids({ source: "web" })).toEqual(["rr-2"]);
      expect(await ids({ number: 4 })).toEqual(["rr-4"]);
      expect(await ids({ prUrl: "https://github.com/acme/web/pull/2" })).toEqual(["rr-2"]);
      expect(await ids({ from: new Date(T0 + 2 * 60_000), to: new Date(T0 + 3 * 60_000) })).toEqual(
        ["rr-3", "rr-2"],
      );
    });

    it.each([
      ["repo", { repo: "no-slash" }],
      ["repo", { repo: "a/b'; drop table review_result; --" }],
      ["limit", { limit: 0 }],
      ["limit", { limit: 101 }],
      ["cursor", { cursor: "%%%" }],
      ["cursor", { cursor: Buffer.from('["x",1]').toString("base64url") }],
      ["from", { from: new Date(T0 + 1), to: new Date(T0) }],
      ["status", { status: "done" as never }],
    ])("rejects an invalid %s filter", async (field, q) => {
      expect(await h.impl.list(q)).toEqual({
        ok: false,
        error: { kind: "validation", field, message: expect.any(String) },
      });
    });
  });
}
