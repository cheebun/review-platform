import { describe, expect, it } from "vitest";
import type { Actor } from "../domain/shared/actor";
import type { NewReviewEvent } from "../ports/review-event-repo";
import type { NewReviewRecord } from "../ports/review-record-repo";
import type { StoredRepo } from "../ports/settings-repo";
import { createTestContainer } from "../testing/container";
import { InMemoryReviewRecordRepo } from "../testing/fakes/in-memory-review-record-repo";
import {
  loadReviewDetail,
  loadReviewList,
  parseReviewIdInput,
  parseReviewListInput,
  type ReviewDeps,
} from "./review.logic";

const me: Actor = { kind: "user", userId: "u1", email: "a@example.com" };
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA2 = "ffffeeee0000111122223333444455556666aaaa";

let seq = 0;
const aRecord = (over: Partial<NewReviewRecord> = {}): NewReviewRecord => {
  seq += 1;
  const number = over.number ?? 7;
  const owner = over.owner ?? "acme";
  const repo = over.repo ?? "web";
  return {
    id: `rev-${seq}`,
    jobId: `job-${seq}`,
    run: 1,
    prUrl: `https://github.com/${owner}/${repo}/pull/${number}`,
    owner,
    repo,
    number,
    headSha: SHA,
    source: "slack",
    requester: { kind: "slack", id: "U123" },
    provider: "anthropic",
    model: "claude-x",
    startedAt: new Date("2026-11-04T01:00:00.000Z"),
    finishedAt: new Date(Date.parse("2026-11-04T02:00:00.000Z") + seq * 1000),
    status: "completed",
    verdict: "pass",
    summary: "Looks fine.",
    findings: [],
    ...over,
  };
};

const anEvent = (over: Partial<NewReviewEvent> & Pick<NewReviewEvent, "type">): NewReviewEvent => {
  seq += 1;
  return {
    id: `ev-${seq}`,
    actor: { kind: "system", id: "owner" },
    at: new Date(Date.parse("2026-11-04T03:00:00.000Z") + seq * 1000),
    ...over,
  };
};

const storedRepo = (canonical: string): StoredRepo => {
  const [owner, repo] = canonical.split("/") as [string, string];
  return {
    owner,
    repo,
    canonical,
    access: "ok",
    permissions: null,
    checkedAt: null,
    addedAt: new Date("2026-11-01T00:00:00.000Z"),
    addedBy: "u1",
  };
};

async function setup(repos: string[] = ["acme/web"]) {
  const { ports } = createTestContainer();
  const reviewRecords = new InMemoryReviewRecordRepo();
  for (const r of repos) {
    const added = await ports.githubRepos.addRepo(storedRepo(r), {
      max: 50,
      event: (s) => ({
        id: `repo-ev-${s.canonical}`,
        type: "github_repo_added",
        actor: { kind: "user", id: "u1" },
        at: new Date("2026-11-01T00:00:00.000Z"),
        detail: { repo: s.canonical },
      }),
    });
    if (!added.ok) throw new Error("seed failed");
  }
  const deps: ReviewDeps = { ...ports, reviewRecords };
  const insert = async (over: Partial<NewReviewRecord> = {}) => {
    const r = await reviewRecords.insert(aRecord(over));
    if (!r.ok) throw new Error(`insert failed: ${JSON.stringify(r.error)}`);
    return r.value.record;
  };
  const event = (over: Partial<NewReviewEvent> & Pick<NewReviewEvent, "type">) =>
    ports.reviewEvents.append(anEvent(over));
  return { deps, ports, reviewRecords, insert, event };
}

describe("parseReviewListInput", () => {
  it.each([
    [undefined, {}],
    [{}, {}],
    [
      {
        repo: "acme/web",
        outcome: "failed",
        source: "web",
        from: "2026-11-01",
        to: "2026-11-04",
        cursor: "abc",
        limit: 20,
      },
      {
        repo: "acme/web",
        outcome: "failed",
        source: "web",
        from: "2026-11-01",
        to: "2026-11-04",
        cursor: "abc",
        limit: 20,
      },
    ],
  ])("%j → %j", (input, expected) => {
    expect(parseReviewListInput(input)).toEqual(expected);
  });

  it.each([
    ["text"],
    [null],
    [[]],
    [{ repo: "no-slash" }],
    [{ repo: "a/b/c" }],
    [{ outcome: "merged" }],
    [{ source: "email" }],
    [{ from: "2026/11/01" }],
    [{ to: "yesterday" }],
    [{ cursor: "" }],
    [{ cursor: "x".repeat(601) }],
    [{ limit: 0 }],
    [{ limit: 101 }],
    [{ limit: 1.5 }],
    [{ extra: 1 }],
  ])("rejects %j", (input) => {
    expect(() => parseReviewListInput(input)).toThrow();
  });
});

describe("parseReviewIdInput", () => {
  it("keeps a string id", () => {
    expect(parseReviewIdInput({ id: "rev-1" })).toEqual({ id: "rev-1" });
  });

  it.each([[undefined], [{}], [{ id: 5 }], [{ id: "x".repeat(201) }], ["rev-1"]])(
    "rejects %j",
    (input) => {
      expect(() => parseReviewIdInput(input)).toThrow();
    },
  );
});

describe("loadReviewList", () => {
  it("empty history: no items, no cursor, and the allowlisted repos for the filter", async () => {
    const { deps } = await setup(["acme/web", "acme/api"]);
    expect(await loadReviewList(deps, me, {})).toEqual({
      ok: true,
      value: { items: [], nextCursor: null, repos: ["acme/api", "acme/web"] },
    });
  });

  it("maps a record to a row: PR, verdict marker, short SHA, requester, time, counts", async () => {
    const { deps, insert } = await setup();
    const rec = await insert({
      verdict: "changes_requested",
      findings: [
        { severity: "P0", title: "a", body: "b" },
        { severity: "P1", title: "c", body: "d" },
        { severity: "P0", title: "e", body: "f" },
      ],
    });
    const res = await loadReviewList(deps, me, {});
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.items).toEqual([
      {
        id: rec.id,
        prUrl: "https://github.com/acme/web/pull/7",
        repo: "acme/web",
        number: 7,
        headSha: SHA,
        shortSha: "a1b2c3d",
        source: "slack",
        requester: { kind: "slack", id: "U123", self: false },
        finishedAt: rec.finishedAt.toISOString(),
        status: "completed",
        verdict: "changes_requested",
        marker: "changes_requested",
        merged: false,
        approval: null,
        findingCounts: [
          { severity: "P0", count: 2 },
          { severity: "P1", count: 1 },
        ],
      },
    ]);
  });

  it("marks the caller's own web review as self", async () => {
    const { deps, insert } = await setup();
    await insert({ source: "web", requester: { kind: "user", id: "u1" } });
    const res = await loadReviewList(deps, me, {});
    expect(res.ok && res.value.items[0]?.requester).toEqual({ kind: "user", id: "u1", self: true });
  });

  it("a failed review has no verdict marker", async () => {
    const { deps, insert } = await setup();
    await insert({ status: "failed", verdict: undefined, errorCategory: "upstream_llm" });
    const res = await loadReviewList(deps, me, {});
    expect(res.ok && res.value.items[0]).toMatchObject({
      status: "failed",
      verdict: null,
      marker: null,
    });
  });

  it("approve outcome comes from this record's events: approved, skipped with reason, failed", async () => {
    const { deps, insert, event } = await setup();
    const a = await insert({ number: 1 });
    const b = await insert({ number: 2 });
    const c = await insert({ number: 3 });
    await event({ type: "approved", prUrl: a.prUrl, jobId: a.jobId, sha: SHA, source: "system" });
    await event({
      type: "approve_skipped",
      prUrl: b.prUrl,
      reviewId: b.id,
      sha: SHA,
      reason: "head_moved",
    });
    await event({ type: "approve_failed", prUrl: c.prUrl, jobId: c.jobId, sha: SHA, reason: "x" });
    const res = await loadReviewList(deps, me, {});
    if (!res.ok) throw new Error("expected ok");
    const byNumber = Object.fromEntries(res.value.items.map((i) => [i.number, i.approval]));
    expect(byNumber[1]).toMatchObject({ kind: "approved", sha: SHA, source: "system" });
    expect(byNumber[2]).toMatchObject({ kind: "skipped", reason: "head_moved" });
    expect(byNumber[3]).toMatchObject({ kind: "failed", reason: "x" });
  });

  it("an approval for another run of the same PR does not count", async () => {
    const { deps, insert, event } = await setup();
    await insert({ headSha: SHA2 });
    await event({
      type: "approved",
      prUrl: "https://github.com/acme/web/pull/7",
      jobId: "other-job",
      sha: SHA,
    });
    const res = await loadReviewList(deps, me, {});
    expect(res.ok && res.value.items[0]?.approval).toBeNull();
  });

  it("force approve shows 🟡 and merged shows ✅", async () => {
    const { deps, insert, event } = await setup();
    const rec = await insert({ verdict: "changes_requested" });
    await event({ type: "force_approved", prUrl: rec.prUrl, reviewId: rec.id, sha: SHA });
    await event({ type: "merged", prUrl: rec.prUrl, sha: SHA2 });
    const res = await loadReviewList(deps, me, {});
    expect(res.ok && res.value.items[0]).toMatchObject({
      marker: "force_approved",
      merged: true,
      approval: { kind: "force_approved", sha: SHA },
    });
  });

  it("hides records of repos that are not in the settings list", async () => {
    const { deps, insert } = await setup(["acme/web"]);
    await insert({ owner: "other", repo: "secret" });
    const kept = await insert();
    const res = await loadReviewList(deps, me, {});
    expect(res.ok && res.value.items.map((i) => i.id)).toEqual([kept.id]);
  });

  it("a repo filter outside the list returns nothing, without querying", async () => {
    const { deps, insert } = await setup(["acme/web"]);
    await insert({ owner: "other", repo: "secret" });
    expect(await loadReviewList(deps, me, { repo: "other/secret" })).toEqual({
      ok: true,
      value: { items: [], nextCursor: null, repos: ["acme/web"] },
    });
  });

  it("filters by repo (case-insensitive), source and outcome", async () => {
    const { deps, insert } = await setup(["acme/web", "acme/api"]);
    const pass = await insert({ verdict: "pass" });
    const changes = await insert({ verdict: "changes_requested" });
    const failed = await insert({
      status: "failed",
      verdict: undefined,
      errorCategory: "upstream_llm",
    });
    const web = await insert({ source: "web", requester: { kind: "user", id: "u1" } });
    const api = await insert({ repo: "api" });
    const ids = async (input: Parameters<typeof loadReviewList>[2]) => {
      const res = await loadReviewList(deps, me, input);
      if (!res.ok) throw new Error("expected ok");
      return res.value.items.map((i) => i.id);
    };
    expect(await ids({ outcome: "pass" })).toEqual([api.id, web.id, pass.id]);
    expect(await ids({ outcome: "changes_requested" })).toEqual([changes.id]);
    expect(await ids({ outcome: "failed" })).toEqual([failed.id]);
    expect(await ids({ source: "web" })).toEqual([web.id]);
    expect(await ids({ repo: "ACME/API" })).toEqual([api.id]);
  });

  it("filters by date range, inclusive, in UTC+8 calendar days", async () => {
    const { deps, insert } = await setup();
    // 2026-11-03 23:30 UTC = 2026-11-04 07:30 UTC+8
    const nov4 = await insert({
      startedAt: new Date("2026-11-03T23:00:00.000Z"),
      finishedAt: new Date("2026-11-03T23:30:00.000Z"),
    });
    // 2026-11-03 15:59 UTC = 2026-11-03 23:59 UTC+8
    const nov3 = await insert({
      startedAt: new Date("2026-11-03T15:00:00.000Z"),
      finishedAt: new Date("2026-11-03T15:59:00.000Z"),
    });
    const ids = async (from?: string, to?: string) => {
      const res = await loadReviewList(deps, me, { from, to });
      if (!res.ok) throw new Error("expected ok");
      return res.value.items.map((i) => i.id);
    };
    expect(await ids("2026-11-04", "2026-11-04")).toEqual([nov4.id]);
    expect(await ids("2026-11-03", "2026-11-03")).toEqual([nov3.id]);
    expect(await ids(undefined, "2026-11-03")).toEqual([nov3.id]);
  });

  it.each([
    [{ from: "2026-11-05", to: "2026-11-04" }],
    [{ from: "2026-02-30" }],
    [{ cursor: "not-a-cursor" }],
  ])("%j is a validation error with a request id", async (input) => {
    const { deps } = await setup();
    expect(await loadReviewList(deps, me, input)).toEqual({
      ok: false,
      error: {
        kind: "validation",
        message: "The request is invalid.",
        requestId: expect.any(String),
      },
    });
  });

  it("pages with the cursor until the end", async () => {
    const { deps, insert } = await setup();
    const recs = [];
    for (let i = 0; i < 5; i++) recs.push(await insert({ number: i + 1 }));
    const first = await loadReviewList(deps, me, { limit: 2 });
    if (!first.ok) throw new Error("expected ok");
    expect(first.value.items.map((i) => i.number)).toEqual([5, 4]);
    expect(first.value.nextCursor).toEqual(expect.any(String));
    const second = await loadReviewList(deps, me, {
      limit: 2,
      cursor: first.value.nextCursor ?? undefined,
    });
    if (!second.ok) throw new Error("expected ok");
    expect(second.value.items.map((i) => i.number)).toEqual([3, 2]);
    const third = await loadReviewList(deps, me, {
      limit: 2,
      cursor: second.value.nextCursor ?? undefined,
    });
    expect(third.ok && third.value).toMatchObject({ nextCursor: null });
    expect(third.ok && third.value.items.map((i) => i.number)).toEqual([1]);
  });

  it("a verdict filter scans further pages so a page is not empty while more match", async () => {
    const { deps, insert } = await setup();
    const wanted = await insert({ verdict: "changes_requested" });
    for (let i = 0; i < 4; i++) await insert({ verdict: "pass" });
    const res = await loadReviewList(deps, me, { outcome: "changes_requested", limit: 2 });
    expect(res.ok && res.value.items.map((i) => i.id)).toEqual([wanted.id]);
  });

  it("a throwing store becomes internal; details only in the log", async () => {
    const { deps, reviewRecords } = await setup();
    reviewRecords.list = async () => {
      throw new Error("postgres://secret-host refused");
    };
    const res = await loadReviewList(deps, me, {});
    expect(JSON.stringify(res)).not.toContain("secret-host");
    expect(res.ok).toBe(false);
  });
});

describe("loadReviewDetail", () => {
  it("unknown, malformed or non-allowlisted ids are not_found", async () => {
    const { deps, insert } = await setup(["acme/web"]);
    const hidden = await insert({ owner: "other", repo: "secret" });
    for (const id of ["nope", "../etc", "a b", hidden.id]) {
      expect(await loadReviewDetail(deps, me, { id })).toEqual({
        ok: false,
        error: {
          kind: "not_found",
          message: "The requested resource was not found.",
          requestId: expect.any(String),
        },
      });
    }
  });

  it("shows the record, the findings grouped by severity and a GitHub link", async () => {
    const { deps, insert } = await setup();
    const rec = await insert({
      verdict: "changes_requested",
      baseSha: SHA2,
      summary: "<b>not html</b>",
      findings: [
        { severity: "Nit", title: "nit", body: "n" },
        { severity: "P0", title: "boom", body: "b", path: "src/a b.ts", line: 12 },
        {
          severity: "P1",
          title: "t",
          titleZh: "中文标题",
          body: "x",
          bodyZh: "中文",
          path: "x.ts",
        },
        { severity: "P0", title: "boom2", body: "b2" },
      ],
    });
    const res = await loadReviewDetail(deps, me, { id: rec.id });
    if (!res.ok) throw new Error("expected ok");
    const v = res.value;
    expect(v.review).toMatchObject({
      id: rec.id,
      repo: "acme/web",
      number: 7,
      headSha: SHA,
      shortSha: "a1b2c3d",
      baseSha: SHA2,
      verdict: "changes_requested",
      marker: "changes_requested",
      summary: "<b>not html</b>",
      provider: "anthropic",
      model: "claude-x",
      startedAt: "2026-11-04T01:00:00.000Z",
      errorCategory: null,
    });
    expect(v.githubUrl).toBe("https://github.com/acme/web/pull/7");
    expect(v.findingGroups.map((g) => [g.severity, g.findings.map((f) => f.title)])).toEqual([
      ["P0", ["boom", "boom2"]],
      ["P1", ["中文标题"]],
      ["Nit", ["nit"]],
    ]);
    expect(v.findingGroups[0]?.findings[0]).toEqual({
      severity: "P0",
      title: "boom",
      body: "b",
      path: "src/a b.ts",
      line: 12,
      href: `https://github.com/acme/web/blob/${SHA}/src/a%20b.ts#L12`,
    });
    expect(v.findingGroups[1]?.findings[0]).toMatchObject({ body: "中文", path: "x.ts" });
    expect(v.newerReview).toBeNull();
  });

  it("unknown severities are grouped after the known ones", async () => {
    const { deps, insert } = await setup();
    const rec = await insert({
      findings: [
        { severity: "P9", title: "odd", body: "" },
        { severity: "P2", title: "p2", body: "" },
      ],
    });
    const res = await loadReviewDetail(deps, me, { id: rec.id });
    expect(res.ok && res.value.findingGroups.map((g) => g.severity)).toEqual(["P2", "P9"]);
  });

  it("no GitHub link and no file links for a non-GitHub URL", async () => {
    const { deps, insert } = await setup();
    const rec = await insert({
      prUrl: "https://evil.example/acme/web/pull/7",
      findings: [{ severity: "P1", title: "t", body: "b", path: "a.ts", line: 1 }],
    });
    const res = await loadReviewDetail(deps, me, { id: rec.id });
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.githubUrl).toBeNull();
    expect(res.value.findingGroups[0]?.findings[0]?.href).toBeUndefined();
  });

  it("the timeline is the PR's review steps, oldest first, without settings events", async () => {
    const { deps, insert, event } = await setup();
    const rec = await insert();
    await event({
      type: "review_finished",
      prUrl: rec.prUrl,
      jobId: rec.jobId,
      at: new Date("2026-11-04T02:00:00.000Z"),
    });
    await event({
      type: "approved",
      prUrl: rec.prUrl,
      jobId: rec.jobId,
      sha: SHA,
      at: new Date("2026-11-04T02:01:00.000Z"),
      source: "system",
    });
    await event({
      type: "merged",
      prUrl: rec.prUrl,
      sha: SHA2,
      actor: { kind: "user", id: "u1" },
      at: new Date("2026-11-04T02:05:00.000Z"),
      source: "web",
    });
    await event({ type: "approved", prUrl: "https://github.com/acme/web/pull/8", sha: SHA });
    const res = await loadReviewDetail(deps, me, { id: rec.id });
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.timeline.map((t) => t.type)).toEqual([
      "review_finished",
      "approved",
      "merged",
    ]);
    expect(res.value.timeline[2]).toEqual({
      id: expect.any(String),
      type: "merged",
      actor: { kind: "user", id: "u1" },
      at: "2026-11-04T02:05:00.000Z",
      sha: SHA2,
      source: "web",
    });
    expect(res.value.review).toMatchObject({ merged: true, approval: { kind: "approved" } });
  });

  it("points to a newer review of the same PR", async () => {
    const { deps, insert } = await setup();
    const old = await insert({ finishedAt: new Date("2026-11-04T02:00:00.000Z") });
    const newer = await insert({
      headSha: SHA2,
      startedAt: new Date("2026-11-04T04:00:00.000Z"),
      finishedAt: new Date("2026-11-04T05:00:00.000Z"),
    });
    const res = await loadReviewDetail(deps, me, { id: old.id });
    expect(res.ok && res.value.newerReview).toEqual({ id: newer.id, shortSha: "ffffeee" });
    const latest = await loadReviewDetail(deps, me, { id: newer.id });
    expect(latest.ok && latest.value.newerReview).toBeNull();
  });

  it("a failed review carries its error category", async () => {
    const { deps, insert } = await setup();
    const rec = await insert({
      status: "failed",
      verdict: undefined,
      errorCategory: "upstream_llm",
    });
    const res = await loadReviewDetail(deps, me, { id: rec.id });
    expect(res.ok && res.value.review).toMatchObject({
      status: "failed",
      marker: null,
      errorCategory: "upstream_llm",
    });
  });
});
