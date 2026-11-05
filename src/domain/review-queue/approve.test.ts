import { describe, expect, it } from "vitest";
import { aReviewJobInState } from "../../testing/builders/review-job";
import { NOW, PASS, RED, URL1, URL2, ms, reviewed, running } from "./fixtures.test-support";
import { transition, type ReviewJobEvent } from "./state-machine";
import type { ApproveOutcome, ReviewJob, UrlProgress } from "./types";

const SHA = "sha-1";
const start = (sha = SHA, url = URL1): ReviewJobEvent => ({ type: "approve_started", url, sha });
const finish = (outcome: ApproveOutcome, url = URL1): ReviewJobEvent => ({
  type: "approve_finished",
  url,
  outcome,
});
const approved: ApproveOutcome = { step: "approved", sha: SHA, githubReviewId: 77 };
const skipped: ApproveOutcome = { step: "approve_skipped", sha: SHA, reason: "own_pr" };
const failedApprove: ApproveOutcome = { step: "approve_failed", sha: SHA, reason: "github 502" };

const withUrl1 = (p: UrlProgress, overrides: Partial<ReviewJob> = {}) =>
  running({ progress: { [URL1]: p }, ...overrides });
const pending = (extra: Partial<UrlProgress> = {}) =>
  withUrl1(reviewed(1, PASS, { approve: { step: "approve_pending", sha: SHA }, ...extra }));

const apply = (job: ReviewJob, ...events: ReviewJobEvent[]) => {
  let current = job;
  for (const event of events) {
    const r = transition(current, event, NOW);
    if (!r.ok) return r;
    current = r.value;
  }
  return { ok: true as const, value: current };
};

describe("approve_started (auto-approve checkpoint, FR-SHIP-01)", () => {
  it("records approve_pending pinned to the reviewed head SHA", () => {
    const r = transition(withUrl1(reviewed(1, PASS)), start(), NOW);
    expect(r).toMatchObject({
      ok: true,
      value: {
        state: "running",
        progress: { [URL1]: { approve: { step: "approve_pending", sha: SHA } } },
      },
    });
  });

  it("rejects a SHA other than the reviewed head SHA", () => {
    expect(transition(withUrl1(reviewed(1, PASS)), start("moved"), NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict", reason: expect.stringMatching(/sha/i) },
    });
  });

  it("refuses a 🔴 verdict", () => {
    expect(transition(withUrl1(reviewed(1, RED)), start(), NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict", reason: expect.stringMatching(/verdict/) },
    });
  });

  it.each([
    ["no review", { reviewed: true, commented: true, pr: reviewed(1, PASS).pr }],
    ["no comment checkpoint", { ...reviewed(1, PASS), commented: undefined }],
    ["no PR checkpoint", { ...reviewed(1, PASS), pr: undefined }],
  ] as [string, UrlProgress][])("refuses a URL with %s", (_n, progress) => {
    expect(transition(withUrl1(progress), start(), NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });

  it("is idempotent: re-sending it after a restart changes nothing", () => {
    const job = pending();
    const r = transition(job, start(), NOW);
    expect(r.ok && r.value.progress).toEqual(job.progress);
  });

  it("is a no-op once the outcome is recorded for the same SHA", () => {
    const job = withUrl1(reviewed(1, PASS, { approve: approved }));
    const r = transition(job, start(), NOW);
    expect(r.ok && r.value.progress[URL1]?.approve).toEqual(approved);
  });

  it("validates the url and the SHA, and needs a running job", () => {
    expect(transition(pending(), start(SHA, "https://x/y"), NOW)).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "url" },
    });
    expect(transition(withUrl1(reviewed(1, PASS)), start(""), NOW)).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
    const queued = aReviewJobInState("queued", { progress: { [URL1]: reviewed(1, PASS) } });
    expect(transition(queued, start(), NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });

  it("refuses a completed URL", () => {
    const job = withUrl1(reviewed(1, PASS, { completed: true }));
    expect(transition(job, start(), NOW)).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });
});

describe("approve_finished", () => {
  it.each([approved, skipped, failedApprove])("records %j after approve_pending", (outcome) => {
    const r = transition(pending(), finish(outcome), NOW);
    expect(r.ok && r.value.progress[URL1]?.approve).toEqual(outcome);
    expect(r.ok && r.value.state).toBe("running"); // a failed APPROVE never fails the job
  });

  it("needs approve_pending first", () => {
    expect(transition(withUrl1(reviewed(1, PASS)), finish(approved), NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict", reason: expect.stringMatching(/approve_pending/) },
    });
  });

  it("must carry the pinned SHA", () => {
    expect(transition(pending(), finish({ ...approved, sha: "other" }), NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict", reason: expect.stringMatching(/sha/i) },
    });
  });

  it("is idempotent for the same outcome and write-once for a different one", () => {
    const done = withUrl1(reviewed(1, PASS, { approve: approved }));
    expect(transition(done, finish(approved), NOW).ok).toBe(true);
    expect(transition(done, finish(skipped), NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });

  it.each([
    { step: "approve_skipped", sha: SHA, reason: "  " },
    { step: "approved", sha: SHA, githubReviewId: 0 },
    { step: "approve_pending", sha: SHA },
  ])("validates the outcome %j", (outcome) => {
    expect(transition(pending(), finish(outcome as ApproveOutcome), NOW)).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
  });
});

describe("approve and the rest of the machine", () => {
  it("the generic checkpoint cannot write `approve`", () => {
    const r = transition(
      withUrl1(reviewed(1, PASS)),
      {
        type: "checkpoint",
        url: URL1,
        // Forbidden by the event type too; the cast checks the runtime guard.
        patch: { approve: { step: "approve_pending", sha: SHA } } as never,
      },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });

  it("reviewSeq is write-once", () => {
    const r = transition(
      withUrl1(reviewed(1, PASS)),
      { type: "checkpoint", url: URL1, patch: { reviewSeq: 9 } },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });

  it("a 🟢 URL completes only once the approve outcome is recorded", () => {
    const complete: ReviewJobEvent = { type: "url_completed", url: URL1 };
    expect(transition(withUrl1(reviewed(1, PASS)), complete, NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict", reason: expect.stringMatching(/approve/) },
    });
    expect(transition(pending(), complete, NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict", reason: expect.stringMatching(/approve/) },
    });
    for (const outcome of [approved, skipped, failedApprove]) {
      expect(transition(withUrl1(reviewed(1, PASS, { approve: outcome })), complete, NOW).ok).toBe(
        true,
      );
    }
  });

  it("a 🔴 URL completes without an approve step", () => {
    const r = transition(withUrl1(reviewed(1, RED)), { type: "url_completed", url: URL1 }, NOW);
    expect(r.ok).toBe(true);
  });

  it("the pending checkpoint survives an interruption, a deferral and a retry", () => {
    const r = apply(
      pending({}),
      { type: "interrupted" },
      { type: "claimed", owner: "w", leaseMs: 1000 },
      { type: "deferred" },
      { type: "claimed", owner: "w", leaseMs: 1000 },
      { type: "failed", error: "x" },
      { type: "retry" },
    );
    expect(r.ok && r.value.progress[URL1]?.approve).toEqual({ step: "approve_pending", sha: SHA });
  });

  it("resumes after a restart: pending -> outcome -> complete", () => {
    const r = apply(
      withUrl1(reviewed(1, PASS), { leaseUntil: ms(-1) }),
      start(),
      { type: "lease_expired" },
      { type: "claimed", owner: "w2", leaseMs: 1000 },
      start(),
      finish(approved),
      { type: "url_completed", url: URL1 },
    );
    expect(r.ok && r.value.progress[URL1]).toMatchObject({ approve: approved, completed: true });
  });

  it("approve events on another URL do not touch URL2", () => {
    const job = running({ progress: { [URL1]: reviewed(1, PASS), [URL2]: reviewed(2, PASS) } });
    const r = transition(job, start(), NOW);
    expect(r.ok && r.value.progress[URL2]).toEqual(job.progress[URL2]);
  });
});
