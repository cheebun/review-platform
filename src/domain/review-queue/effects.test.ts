import { describe, expect, it } from "vitest";
import { aReviewJobInState } from "../../testing/builders/review-job";
import { NOW, PASS, RED, URL1, URL2, ms, reviewed, running } from "./fixtures.test-support";
import {
  initialProgress,
  nextReviewSeq,
  reviewAcceptedIntents,
  step,
  supersedes,
  transition,
  type ReviewJobEvent,
} from "./state-machine";
import type { ReviewJob } from "./types";

const APPROVED = { step: "approved", sha: "sha-1", githubReviewId: 77 } as const;
const STARTED = new Date("2026-01-01T00:01:00.000Z");

/** URL1 🟢 approved, URL2 🔴, both completed. */
const finished = (overrides: Partial<ReviewJob> = {}) =>
  running({
    runStartedAt: STARTED,
    attempts: 2,
    progress: {
      [URL1]: reviewed(1, PASS, { approve: APPROVED, completed: true }),
      [URL2]: reviewed(2, RED, { completed: true }),
    },
    ...overrides,
  });

const must = (job: ReviewJob, event: ReviewJobEvent, now = NOW) => {
  const r = step(job, event, now);
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.error)}`);
  return r.value;
};

describe("terminal transition: done", () => {
  it("both sources go straight from all_completed to done and release the lease", () => {
    for (const source of ["slack", "web"] as const) {
      const out = must(finished({ source }), { type: "all_completed" });
      expect(out.job).toMatchObject({ state: "done", leaseOwner: null, leaseUntil: null });
    }
  });

  it("produces exactly one review record per URL with every field", () => {
    const out = must(finished(), { type: "all_completed" });
    expect(out.records).toHaveLength(2);
    expect(out.records[0]).toEqual({
      jobId: "job-1",
      prUrl: URL1,
      attempt: 2,
      reviewSeq: 1,
      source: "slack",
      requester: { kind: "slack", id: "U1" },
      pr: { owner: "acme", repo: "app", number: 1, headSha: "sha-1", baseSha: "base-1" },
      status: "done",
      verdict: "pass",
      githubEvent: "APPROVE",
      highestSeverity: "P2",
      summary: PASS.summary,
      findings: PASS.findings,
      verificationRequests: PASS.verificationRequests,
      approve: APPROVED,
      failure: null,
      startedAt: STARTED,
      finishedAt: NOW,
    });
    expect(out.records[1]).toMatchObject({
      prUrl: URL2,
      reviewSeq: 2,
      verdict: "changes_requested",
      githubEvent: "REQUEST_CHANGES",
      highestSeverity: "P0",
      approve: null,
    });
  });

  it("emits the verdict reaction intents for a Slack job, in URL order", () => {
    const out = must(finished(), { type: "all_completed" });
    expect(out.intents).toEqual([
      {
        prUrl: URL1,
        jobId: "job-1",
        reviewSeq: 1,
        channel: "C1",
        ts: "1700000000.000100",
        target: "pass",
      },
      {
        prUrl: URL2,
        jobId: "job-1",
        reviewSeq: 2,
        channel: "C1",
        ts: "1700000000.000100",
        target: "changes_requested",
      },
    ]);
  });

  it("a web job records but emits no reaction intents", () => {
    const out = must(finished({ source: "web", slack: undefined, actorUserId: "user-9" }), {
      type: "all_completed",
    });
    expect(out.intents).toEqual([]);
    expect(out.records.map((r) => r.requester)).toEqual([
      { kind: "user", id: "user-9" },
      { kind: "user", id: "user-9" },
    ]);
  });

  it("marks every recorded URL so no later run records it again", () => {
    const out = must(finished(), { type: "all_completed" });
    expect(out.job.progress[URL1]?.recorded).toBe(true);
    expect(out.job.progress[URL2]?.recorded).toBe(true);
  });

  it("a completed URL without a review is recorded without a verdict and clears ⏳", () => {
    const out = must(
      running({ urls: [URL1], progress: { [URL1]: { completed: true, reviewSeq: 4 } } }),
      { type: "all_completed" },
    );
    expect(out.records[0]).toMatchObject({
      status: "done",
      verdict: null,
      pr: null,
      summary: null,
    });
    expect(out.intents[0]).toMatchObject({ target: "none", reviewSeq: 4 });
  });

  it("transition() returns the same job as step()", () => {
    const job = finished();
    const r = transition(job, { type: "all_completed" }, NOW);
    expect(r.ok && r.value).toEqual(must(job, { type: "all_completed" }).job);
  });
});

describe("terminal transition: failed", () => {
  const half = () =>
    running({
      attempts: 1,
      progress: {
        [URL1]: reviewed(1, PASS, { approve: APPROVED, completed: true }),
        [URL2]: reviewed(2, PASS, { approve: { step: "approve_pending", sha: "sha-2" } }),
      },
    });

  it("records completed URLs as done and the others as failed with a generic category", () => {
    const out = must(half(), { type: "failed", error: "secret raw error", category: "upstream" });
    expect(out.job.state).toBe("failed");
    expect(out.records.map((r) => [r.prUrl, r.status, r.verdict, r.failure])).toEqual([
      [URL1, "done", "pass", null],
      [URL2, "failed", null, "upstream"],
    ]);
    expect(JSON.stringify(out.records)).not.toContain("secret raw error");
    expect(out.records[1]?.approve).toEqual({ step: "approve_pending", sha: "sha-2" });
  });

  it("removes ⏳ from failed URLs without a verdict emoji", () => {
    const out = must(half(), { type: "failed", error: "x" });
    expect(out.intents.map((i) => [i.prUrl, i.target])).toEqual([
      [URL1, "pass"],
      [URL2, "none"],
    ]);
  });

  it("defaults the category to internal and marks only completed URLs as recorded", () => {
    const out = must(half(), { type: "failed", error: "x" });
    expect(out.records[1]?.failure).toBe("internal");
    expect(out.job.progress[URL1]?.recorded).toBe(true);
    expect(out.job.progress[URL2]?.recorded).toBeUndefined();
  });

  it("the interruption limit is a terminal transition with category interrupted", () => {
    const out = must(half(), { type: "interrupted" });
    expect(out.job.state).toBe("queued");
    expect(out.records).toEqual([]);
    const last = must({ ...half(), interruptions: 2 }, { type: "interrupted" });
    expect(last.job.state).toBe("failed");
    expect(last.records.map((r) => r.failure)).toEqual([null, "interrupted"]);
  });

  it("a retried job records only the URLs that were not recorded yet, at the new attempt", () => {
    const failed = must(half(), { type: "failed", error: "x" });
    const retried = must(failed.job, { type: "retry" });
    expect(retried.records).toEqual([]);
    expect(retried.intents.map((i) => [i.prUrl, i.target])).toEqual([[URL2, "reviewing"]]);
    let job = must(retried.job, { type: "claimed", owner: "w", leaseMs: 1000 }, ms(1)).job;
    job = must(job, {
      type: "approve_finished",
      url: URL2,
      outcome: { ...APPROVED, sha: "sha-2" },
    }).job;
    job = must(job, { type: "url_completed", url: URL2 }).job;
    const done = must(job, { type: "all_completed" }, ms(2));
    expect(done.records.map((r) => [r.prUrl, r.attempt, r.status])).toEqual([[URL2, 2, "done"]]);
    expect(done.records[0]?.startedAt).toEqual(ms(1));
    expect(done.intents.map((i) => i.prUrl)).toEqual([URL2]);
  });
});

describe("no effects outside the terminal transition", () => {
  it.each([
    ["checkpoint", running(), { type: "checkpoint", url: URL1, patch: { reviewed: true } }],
    ["claimed", aReviewJobInState("queued"), { type: "claimed", owner: "w", leaseMs: 1000 }],
    ["deferred", running(), { type: "deferred" }],
    ["reply_sent on done", aReviewJobInState("done"), { type: "reply_sent" }],
    ["reply_sent on failed", aReviewJobInState("failed"), { type: "reply_sent" }],
  ] as [string, ReviewJob, ReviewJobEvent][])("%s", (_n, job, event) => {
    const out = must(job, event);
    expect(out.records).toEqual([]);
    expect(out.intents).toEqual([]);
  });
});

describe("runStartedAt", () => {
  it("is set by the first claim of a run, kept across a deferral, cleared by retry", () => {
    let job = must(aReviewJobInState("queued"), { type: "claimed", owner: "w", leaseMs: 1000 }).job;
    expect(job.runStartedAt).toEqual(NOW);
    job = must(job, { type: "deferred" }).job;
    job = must(job, { type: "claimed", owner: "w", leaseMs: 1000 }, ms(5000)).job;
    expect(job.runStartedAt).toEqual(NOW);
    job = must(job, { type: "failed", error: "x" }).job;
    expect(must(job, { type: "retry" }).job.runStartedAt).toBeUndefined();
  });

  it("falls back to createdAt in the record when unknown", () => {
    const out = must(finished({ runStartedAt: undefined }), { type: "all_completed" });
    expect(out.records[0]?.startedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });
});

describe("review sequence per PR (re-review: latest wins)", () => {
  it.each([
    [undefined, 1],
    [null, 1],
    [0, 1],
    [4, 5],
  ] as const)("nextReviewSeq(%s) = %s", (latest, expected) => {
    expect(nextReviewSeq(latest)).toBe(expected);
  });

  it.each([-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
    "nextReviewSeq rejects a corrupt latest value %s by throwing a RangeError",
    (latest) => {
      expect(() => nextReviewSeq(latest)).toThrow(RangeError);
    },
  );

  it("initialProgress assigns each URL the next sequence of its own PR", () => {
    const latest = new Map([[URL1, 3]]);
    expect(initialProgress([URL1, URL2], (u) => latest.get(u))).toEqual({
      [URL1]: { reviewSeq: 4 },
      [URL2]: { reviewSeq: 1 },
    });
  });

  it("reviewAcceptedIntents puts ⏳ on every PR of a Slack job", () => {
    const job = aReviewJobInState("queued", {
      urls: [URL1, URL2],
      progress: initialProgress([URL1, URL2], () => 1),
    });
    expect(reviewAcceptedIntents(job)).toEqual([
      {
        prUrl: URL1,
        jobId: "job-1",
        reviewSeq: 2,
        channel: "C1",
        ts: "1700000000.000100",
        target: "reviewing",
      },
      {
        prUrl: URL2,
        jobId: "job-1",
        reviewSeq: 2,
        channel: "C1",
        ts: "1700000000.000100",
        target: "reviewing",
      },
    ]);
    expect(reviewAcceptedIntents({ ...job, source: "web", slack: undefined })).toEqual([]);
  });

  it("a re-review supersedes the earlier review's intents, even if the earlier one finishes later", () => {
    const first = must(
      finished({
        urls: [URL1],
        progress: { [URL1]: reviewed(1, RED, { completed: true, reviewSeq: 1 }) },
      }),
      {
        type: "all_completed",
      },
    );
    const second = reviewAcceptedIntents(
      aReviewJobInState("queued", { id: "job-2", progress: initialProgress([URL1], () => 1) }),
    );
    expect(supersedes(second[0]!, first.intents[0]!)).toBe(true);
    expect(supersedes(first.intents[0]!, second[0]!)).toBe(false);
    expect(supersedes(second[0]!, second[0]!)).toBe(false);
  });
});
