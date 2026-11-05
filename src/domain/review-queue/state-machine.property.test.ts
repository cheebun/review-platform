import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { aReviewJobInState } from "../../testing/builders/review-job";
import type { ReviewRecord } from "../review/types";
import { step as applyEvent, type ReviewJobEvent } from "./state-machine";
import type { ReactionIntent, ReviewJob, UrlProgress } from "./types";

// Fixed seed so CI is deterministic. Replay or explore with FC_SEED=<n> (fast-check prints the seed on failure).
const SEED = Number(process.env.FC_SEED ?? 20260101);
const RUNS = Number(process.env.FC_RUNS ?? 500);
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

const URLS = [
  "https://github.com/acme/app/pull/1",
  "https://github.com/acme/app/pull/2",
  "https://github.com/acme/app/pull/3",
];
const review = (summary: string) => ({ summary, findings: [], verificationRequests: [] });
const red = {
  summary: "red",
  findings: [{ severity: "P0" as const, title: "t", body: "b" }],
  verificationRequests: [],
};
const prOf = (url: string, sha: string) => ({
  owner: "acme",
  repo: "app",
  number: Number(url.split("/").pop()),
  title: "t",
  author: "dev",
  htmlUrl: url,
  base: "main",
  head: "f",
  sha,
  baseSha: "b",
});
const SHAS = ["s1", "s2"];
const PATCHES: Partial<UrlProgress>[] = [
  { reviewed: true },
  { reviewed: false },
  { commented: true },
  { submitted: true },
  { merged: true },
  { merged: false },
  { commentId: 5 },
  { commentId: 6 },
  { githubReviewId: 9 },
  { review: review("a") },
  { review: review("b") },
  { batchReview: undefined },
  { commentId: -1 },
  { review: red },
  { commented: true },
  { commented: true },
  { reviewSeq: 7 },
];

type Step = { pick: number; dt: number; patch: number };

/** The next happy-path event for an open URL, so approve outcomes and `done` are actually reached. */
function guided(job: ReviewJob, step: Step): ReviewJobEvent {
  const open = job.urls.filter((u) => !job.progress[u]?.completed);
  const url = open[step.pick % Math.max(open.length, 1)];
  if (!url) return { type: "all_completed" };
  const p = job.progress[url] ?? {};
  if (!p.pr) return { type: "checkpoint", url, patch: { pr: prOf(url, SHAS[step.patch % 2]!) } };
  if (!p.review) {
    return { type: "checkpoint", url, patch: { review: step.pick % 4 === 0 ? red : review("a") } };
  }
  if (!p.commented) return { type: "checkpoint", url, patch: { commented: true } };
  const pass = p.review.findings.length === 0;
  if (pass && !p.approve) return { type: "approve_started", url, sha: p.pr.sha };
  if (pass && p.approve?.step === "approve_pending") {
    return { type: "approve_finished", url, outcome: OUTCOMES[step.patch % 3]!(p.approve.sha) };
  }
  return { type: "url_completed", url };
}

const OUTCOMES = [
  (sha: string) => ({ step: "approved" as const, sha, githubReviewId: 3 }),
  (sha: string) => ({ step: "approve_skipped" as const, sha, reason: "own_pr" }),
  (sha: string) => ({ step: "approve_failed" as const, sha, reason: "github 502" }),
];

/** Events worth trying in the current state: mostly legal ones, plus a few illegal ones that must conflict. */
function candidates(job: ReviewJob, step: Step): ReviewJobEvent[] {
  const url = job.urls[step.pick % job.urls.length]!;
  const open = job.urls.filter((u) => !job.progress[u]?.completed);
  const sha = job.progress[url]?.pr?.sha ?? SHAS[step.patch % SHAS.length]!;
  const otherSha = SHAS[(step.patch + 1) % SHAS.length]!;
  const patch =
    step.patch % 5 === 0
      ? { pr: prOf(url, SHAS[step.pick % SHAS.length]!) }
      : PATCHES[step.patch % PATCHES.length]!;
  const common: ReviewJobEvent[] = [
    { type: "checkpoint", url, patch },
    { type: "approve_started", url, sha: step.pick % 7 === 0 ? otherSha : sha },
    {
      type: "approve_finished",
      url,
      outcome: OUTCOMES[step.patch % OUTCOMES.length]!(step.pick % 9 === 0 ? otherSha : sha),
    },
  ];
  switch (job.state) {
    case "queued":
      return [
        { type: "claimed", owner: "w", leaseMs: 330_000 },
        { type: "claimed", owner: "w", leaseMs: 330_000 },
        { type: "claimed", owner: "w", leaseMs: 330_000 },
        ...common,
        { type: "failed", error: "x" },
      ];
    case "running":
      return [
        ...common,
        ...common,
        ...Array.from({ length: 12 }, () => guided(job, step)),
        { type: "url_completed", url: open[step.pick % Math.max(open.length, 1)] ?? url },
        { type: "url_completed", url: open[step.pick % Math.max(open.length, 1)] ?? url },
        { type: "all_completed" },
        { type: "deferred" },
        { type: "failed", error: "boom" },
        { type: "failed", error: "boom", category: "upstream" },
        { type: "interrupted" },
        { type: "lease_expired" },
        { type: "interruption_limit" },
        { type: "claimed", owner: "w", leaseMs: 1000 },
      ];
    case "failed":
      return [{ type: "retry" }, { type: "retry" }, { type: "reply_sent" }, ...common];
    case "done":
      return [
        { type: "retry" },
        { type: "claimed", owner: "w", leaseMs: 1 },
        { type: "reply_sent" },
        { type: "all_completed" },
        ...common,
      ];
  }
}

const FLAGS = [
  "reviewed",
  "commented",
  "submitted",
  "merged",
  "replied",
  "reacted",
  "completed",
  "recorded",
] as const;

const TERMINAL = new Set(["done", "failed"]);
type Outcome = ReturnType<typeof applyEvent>;

const arbScenario = fc.record({
  source: fc.constantFrom<"slack" | "web">("slack", "slack", "web"),
  urlCount: fc.integer({ min: 1, max: 3 }),
  steps: fc.array(
    fc.record({
      pick: fc.nat(1000),
      dt: fc.constantFrom(0, 1000, 31_000, 400_000),
      patch: fc.nat(1000),
    }),
    { minLength: 1, maxLength: 60 },
  ),
});

const stats = { done: 0, failed: 0, retried: 0, steps: 0, approved: 0, records: 0 };

type Check = (
  prev: ReviewJob,
  event: ReviewJobEvent,
  result: Outcome,
  history: { records: ReviewRecord[]; intents: ReactionIntent[] },
) => void;

/** Runs a random sequence, calling `check` on every applied or rejected step. */
function walk(
  scenario: { source: "slack" | "web"; urlCount: number; steps: Step[] },
  check: Check,
) {
  const history = { records: [] as ReviewRecord[], intents: [] as ReactionIntent[] };
  let job = aReviewJobInState("queued", {
    source: scenario.source,
    urls: URLS.slice(0, scenario.urlCount),
  });
  let t = T0;
  for (const step of scenario.steps) {
    t += step.dt;
    const options = candidates(job, step);
    const event = options[step.pick % options.length]!;
    const result = applyEvent(job, event, new Date(t));
    stats.steps++;
    check(job, event, result, history);
    if (result.ok) {
      const nextJob = result.value.job;
      if (nextJob.state === "done" && job.state !== "done") stats.done++;
      if (nextJob.state === "failed" && job.state !== "failed") stats.failed++;
      if (event.type === "retry") stats.retried++;
      if (event.type === "approve_finished" && result.value.job !== job) stats.approved++;
      stats.records += result.value.records.length;
      history.records.push(...result.value.records);
      history.intents.push(...result.value.intents);
      job = nextJob;
    }
  }
}

const run = (check: Check) =>
  fc.assert(
    fc.property(arbScenario, (s) => {
      walk(s, check);
    }),
    { seed: SEED, numRuns: RUNS },
  );

describe(`review job invariants (seed ${SEED}, ${RUNS} runs each)`, () => {
  it("no transition leaves a terminal state; the only exit is retry from failed to queued", () => {
    run((prev, event, r) => {
      if (!r.ok || !TERMINAL.has(prev.state)) return;
      if (r.value.job.state !== prev.state) {
        expect(prev.state).toBe("failed");
        expect(event.type).toBe("retry");
        expect(r.value.job.state).toBe("queued");
      }
      if (prev.state === "done") expect(r.value.job.state).toBe("done");
      if (event.type === "retry") expect(prev.state).toBe("failed");
    });
  });

  it("records appear only on entering a terminal state, one per URL not yet recorded", () => {
    run((prev, _e, r) => {
      if (!r.ok) return;
      const { job, records } = r.value;
      const entered = !TERMINAL.has(prev.state) && TERMINAL.has(job.state);
      if (!entered) {
        expect(records).toEqual([]);
        return;
      }
      const expected = prev.urls.filter(
        (u) => !(prev.progress[u]?.completed && prev.progress[u]?.recorded),
      );
      expect(records.map((x) => x.prUrl)).toEqual(expected);
      for (const rec of records) {
        expect(rec.jobId).toBe(prev.id);
        expect(rec.attempt).toBe(job.attempts);
        expect(rec.status).toBe(job.progress[rec.prUrl]?.completed ? "done" : "failed");
        if (job.state === "done") expect(rec.status).toBe("done");
        expect(rec.verdict === null).toBe(rec.status === "failed" || rec.summary === null);
      }
    });
  });

  it("exactly one record per (job, URL, run): keys never repeat and a completed URL is recorded once", () => {
    run((_p, _e, r, history) => {
      if (!r.ok) return;
      const all = [...history.records, ...r.value.records];
      const keys = all.map((x) => `${x.prUrl}#${x.attempt}`);
      expect(new Set(keys).size).toBe(keys.length);
      const done = all.filter((x) => x.status === "done").map((x) => x.prUrl);
      expect(new Set(done).size).toBe(done.length);
    });
  });

  it("reaction intents come only with the terminal transition (verdict) or retry (⏳), and only for slack", () => {
    run((prev, event, r) => {
      if (!r.ok) return;
      const { job, intents } = r.value;
      if (intents.length === 0) return;
      expect(prev.source).toBe("slack");
      const entered = !TERMINAL.has(prev.state) && TERMINAL.has(job.state);
      expect(entered || event.type === "retry").toBe(true);
      for (const i of intents) {
        expect(i.reviewSeq).toBe(job.progress[i.prUrl]?.reviewSeq ?? 0);
        if (event.type === "retry") expect(i.target).toBe("reviewing");
        else {
          const rec = r.value.records.find((x) => x.prUrl === i.prUrl);
          expect(i.target).toBe(rec?.verdict ?? "none");
        }
      }
    });
  });

  it("the approve checkpoint is pinned to the reviewed head SHA, only on a pass, and never reopens", () => {
    run((prev, _e, r) => {
      if (!r.ok) return;
      for (const url of prev.urls) {
        const before = prev.progress[url]?.approve;
        const p = r.value.job.progress[url] ?? {};
        if (p.approve) {
          expect(p.approve.sha).toBe(p.pr?.sha);
          expect(p.review?.findings.every((f) => f.severity !== "P0")).toBe(true);
          expect(p.commented).toBe(true);
        }
        if (before) {
          expect(p.approve?.sha).toBe(before.sha);
          if (before.step !== "approve_pending") expect(p.approve).toEqual(before);
        }
      }
    });
  });

  it("a passing URL never completes before its approve outcome is recorded", () => {
    run((_p, _e, r) => {
      if (!r.ok) return;
      for (const p of Object.values(r.value.job.progress)) {
        const pass = p.review && p.review.findings.every((f) => f.severity !== "P0");
        if (p.completed && pass) {
          expect(p.approve && p.approve.step !== "approve_pending").toBeTruthy();
        }
      }
    });
  });

  it("a checkpoint flag, once true, never goes back to false; write-once ids never change", () => {
    run((prev, _e, r) => {
      if (!r.ok) return;
      for (const url of prev.urls) {
        const a = prev.progress[url] ?? {};
        const b = r.value.job.progress[url] ?? {};
        for (const flag of FLAGS) if (a[flag] === true) expect(b[flag]).toBe(true);
        if (a.commentId !== undefined) expect(b.commentId).toBe(a.commentId);
        if (a.githubReviewId !== undefined) expect(b.githubReviewId).toBe(a.githubReviewId);
        if (a.review !== undefined) expect(b.review).toEqual(a.review);
        if (a.reviewSeq !== undefined) expect(b.reviewSeq).toBe(a.reviewSeq);
      }
    });
  });

  it("attempts never decrease, and only `claimed` increases them", () => {
    run((prev, event, r) => {
      if (!r.ok) return;
      expect(r.value.job.attempts).toBeGreaterThanOrEqual(prev.attempts);
      if (event.type !== "claimed") expect(r.value.job.attempts).toBe(prev.attempts);
    });
  });

  it("version, createdAt, id and urls are untouched (the repo owns them)", () => {
    run((prev, _e, r) => {
      if (!r.ok) return;
      const job = r.value.job;
      expect(job.version).toBe(prev.version);
      expect(job.createdAt).toEqual(prev.createdAt);
      expect(job.id).toBe(prev.id);
      expect(job.urls).toEqual(prev.urls);
      expect(job.source).toBe(prev.source);
    });
  });

  it("a job reaches done only through all_completed, with every URL completed", () => {
    run((prev, event, r) => {
      if (!r.ok || r.value.job.state !== "done" || prev.state === "done") return;
      expect(event.type).toBe("all_completed");
      expect(r.value.job.urls.every((u) => r.value.job.progress[u]?.completed === true)).toBe(true);
    });
  });

  it("a rejected event never throws and returns a conflict or validation error", () => {
    run((_p, _e, r) => {
      if (!r.ok) expect(["conflict", "validation"]).toContain(r.error.kind);
    });
  });

  it("the interruption counter never reaches the limit while the job is still queued or running", () => {
    run((_p, _e, r) => {
      const job = r.ok ? r.value.job : undefined;
      if (job && (job.state === "queued" || job.state === "running")) {
        expect(job.interruptions ?? 0).toBeLessThan(3);
      }
    });
  });

  it("the generator actually reaches done, failed, retry, approve outcomes and records", () => {
    expect(stats.done).toBeGreaterThan(0);
    expect(stats.failed).toBeGreaterThan(0);
    expect(stats.retried).toBeGreaterThan(0);
    expect(stats.approved).toBeGreaterThan(0);
    expect(stats.records).toBeGreaterThan(0);
  });
});
