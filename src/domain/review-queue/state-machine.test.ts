import { describe, expect, it } from "vitest";
import { aReviewJob, aReviewJobInState } from "../../testing/builders/review-job";
import { interruptionsExhausted, step, transition, type ReviewJobEvent } from "./state-machine";
import type { ReviewJob, ReviewJobState, UrlProgress } from "./types";

const NOW = new Date("2026-01-01T00:10:00.000Z");
const URL1 = "https://github.com/acme/app/pull/1";
const URL2 = "https://github.com/acme/app/pull/2";
const ms = (n: number) => new Date(NOW.getTime() + n);

type Expectation = { ok: Partial<ReviewJob> } | { conflict: RegExp };

type Row = [ReviewJobState, ReviewJobEvent, Expectation];

const claim: ReviewJobEvent = { type: "claimed", owner: "w2", leaseMs: 330_000 };
const checkpoint: ReviewJobEvent = { type: "checkpoint", url: URL1, patch: { reviewed: true } };
const failedEv: ReviewJobEvent = { type: "failed", error: "kaput" };
const approveStart: ReviewJobEvent = { type: "approve_started", url: URL1, sha: "sha-1" };
const approveFinish: ReviewJobEvent = {
  type: "approve_finished",
  url: URL1,
  outcome: { step: "approved", sha: "sha-1", githubReviewId: 1 },
};
const bare = (
  type: Exclude<
    ReviewJobEvent["type"],
    "claimed" | "checkpoint" | "url_completed" | "failed" | "approve_started" | "approve_finished"
  >,
): ReviewJobEvent => ({ type }) as ReviewJobEvent;

// One row per (state x event) pair: 4 states x 13 events = 52.
const TABLE: Row[] = [
  // queued
  [
    "queued",
    claim,
    {
      ok: {
        state: "running",
        leaseOwner: "w2",
        leaseUntil: ms(330_000),
        attempts: 1,
        nextAttemptAt: null,
      },
    },
  ],
  ["queued", bare("lease_expired"), { conflict: /queued/ }],
  ["queued", bare("interruption_limit"), { conflict: /queued/ }],
  ["queued", bare("interrupted"), { conflict: /queued/ }],
  ["queued", checkpoint, { conflict: /queued/ }],
  ["queued", { type: "url_completed", url: URL1 }, { conflict: /queued/ }],
  ["queued", bare("deferred"), { conflict: /queued/ }],
  ["queued", bare("all_completed"), { conflict: /queued/ }],
  ["queued", bare("reply_sent"), { conflict: /queued/ }],
  ["queued", approveStart, { conflict: /queued/ }],
  ["queued", approveFinish, { conflict: /queued/ }],
  ["queued", failedEv, { conflict: /queued/ }],
  ["queued", bare("retry"), { conflict: /queued/ }],
  // running (lease active, URL not completed)
  ["running", claim, { conflict: /lease|running/ }],
  ["running", bare("lease_expired"), { conflict: /lease/ }],
  ["running", bare("interruption_limit"), { conflict: /interruption/ }],
  [
    "running",
    bare("interrupted"),
    { ok: { state: "queued", interruptions: 1, leaseOwner: null, leaseUntil: null } },
  ],
  ["running", checkpoint, { ok: { state: "running", progress: { [URL1]: { reviewed: true } } } }],
  [
    "running",
    { type: "url_completed", url: URL1 },
    { ok: { state: "running", progress: { [URL1]: { completed: true } } } },
  ],
  [
    "running",
    bare("deferred"),
    { ok: { state: "queued", nextAttemptAt: null, leaseOwner: null, leaseUntil: null } },
  ],
  ["running", bare("all_completed"), { conflict: /complete/ }],
  ["running", bare("reply_sent"), { conflict: /running/ }],
  ["running", approveStart, { conflict: /review/ }],
  ["running", approveFinish, { conflict: /approve_pending/ }],
  [
    "running",
    failedEv,
    { ok: { state: "failed", lastError: "kaput", leaseOwner: null, leaseUntil: null } },
  ],
  ["running", bare("retry"), { conflict: /running/ }],
  // failed
  ["failed", claim, { conflict: /failed/ }],
  ["failed", bare("lease_expired"), { conflict: /failed/ }],
  ["failed", bare("interruption_limit"), { conflict: /failed/ }],
  ["failed", bare("interrupted"), { conflict: /failed/ }],
  ["failed", checkpoint, { conflict: /failed/ }],
  ["failed", { type: "url_completed", url: URL1 }, { conflict: /failed/ }],
  ["failed", bare("deferred"), { conflict: /failed/ }],
  ["failed", bare("all_completed"), { conflict: /failed/ }],
  [
    "failed",
    bare("reply_sent"),
    { ok: { state: "failed", resultReplySent: true, lastError: "boom" } },
  ],
  ["failed", approveStart, { conflict: /failed/ }],
  ["failed", approveFinish, { conflict: /failed/ }],
  ["failed", failedEv, { conflict: /failed/ }],
  ["failed", bare("retry"), { ok: { state: "queued", nextAttemptAt: null, leaseOwner: null } }],
  // done
  ["done", claim, { conflict: /done/ }],
  ["done", bare("lease_expired"), { conflict: /done/ }],
  ["done", bare("interruption_limit"), { conflict: /done/ }],
  ["done", bare("interrupted"), { conflict: /done/ }],
  ["done", checkpoint, { conflict: /done/ }],
  ["done", { type: "url_completed", url: URL1 }, { conflict: /done/ }],
  ["done", bare("deferred"), { conflict: /done/ }],
  ["done", bare("all_completed"), { conflict: /done/ }],
  ["done", bare("reply_sent"), { ok: { state: "done", resultReplySent: true } }],
  ["done", approveStart, { conflict: /done/ }],
  ["done", approveFinish, { conflict: /done/ }],
  ["done", failedEv, { conflict: /done/ }],
  ["done", bare("retry"), { conflict: /done/ }],
];

describe("transition: (state x event) table", () => {
  it("covers every pair exactly once", () => {
    expect(TABLE).toHaveLength(52);
    expect(new Set(TABLE.map(([s, e]) => `${s}/${e.type}`)).size).toBe(52);
  });

  it.each(TABLE)("%s + %j", (state, event, expected) => {
    const job = aReviewJobInState(state);
    const before = structuredClone(job);
    const r = transition(job, event, NOW);
    expect(job).toEqual(before); // input is never mutated
    if ("ok" in expected) {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toMatchObject(expected.ok);
      expect(r.value.version).toBe(job.version);
      expect(r.value.createdAt).toEqual(job.createdAt);
      expect(r.value.updatedAt).toEqual(NOW);
    } else {
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe("conflict");
      if (r.error.kind === "conflict") expect(r.error.reason).toMatch(expected.conflict);
    }
  });
});

describe("claimed", () => {
  it("rejects a queued job whose nextAttemptAt is in the future", () => {
    const job = aReviewJobInState("queued", { nextAttemptAt: ms(1) });
    expect(transition(job, claim, NOW)).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });
  it("accepts a queued job that is due", () => {
    const job = aReviewJobInState("queued", { nextAttemptAt: ms(0) });
    expect(transition(job, claim, NOW).ok).toBe(true);
  });
  it("rejects a job whose lease is still held", () => {
    const job = aReviewJobInState("queued", { leaseOwner: "w1", leaseUntil: ms(1) });
    expect(transition(job, claim, NOW)).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });
  it.each([
    [{ type: "claimed", owner: "", leaseMs: 1000 }],
    [{ type: "claimed", owner: "w", leaseMs: 0 }],
    [{ type: "claimed", owner: "w", leaseMs: Number.NaN }],
  ] as [ReviewJobEvent][])("validates %j", (event) => {
    expect(transition(aReviewJobInState("queued"), event, NOW)).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
  });
});

const expired = (n?: number) =>
  aReviewJobInState("running", { leaseUntil: ms(0), interruptions: n });

describe("interruptions (lease_expired / interrupted)", () => {
  it.each([
    [undefined, "queued", 1],
    [1, "queued", 2],
    [2, "failed", 3],
  ] as const)("lease_expired with %s prior interruptions -> %s", (prior, state, count) => {
    const r = transition(expired(prior), { type: "lease_expired" }, NOW);
    expect(r).toMatchObject({
      ok: true,
      value: { state, interruptions: count, leaseOwner: null, leaseUntil: null },
    });
    if (r.ok && state === "failed") expect(r.value.lastError).toMatch(/3/);
  });

  it("interrupted uses the same counter without a lease check", () => {
    const job = aReviewJobInState("running", { interruptions: 2 });
    expect(transition(job, { type: "interrupted" }, NOW)).toMatchObject({
      ok: true,
      value: { state: "failed", interruptions: 3 },
    });
  });
});

describe("interruption_limit (a lease reclaim that exhausted the interruptions)", () => {
  it("fails a running job whose reclaims reached the limit, without counting again", () => {
    const job = aReviewJobInState("running", { interruptions: 3, leaseOwner: "w4" });
    const r = step(job, { type: "interruption_limit" }, NOW);
    expect(r).toMatchObject({
      ok: true,
      value: {
        job: { state: "failed", interruptions: 3, leaseOwner: null, leaseUntil: null },
      },
    });
    if (!r.ok) return;
    expect(r.value.job.lastError).toMatch(/3/);
    expect(r.value.records.map((rec) => rec.failure)).toEqual(job.urls.map(() => "interrupted"));
  });

  it.each([undefined, 0, 2])("is a conflict below the limit (%s interruptions)", (n) => {
    const job = aReviewJobInState("running", { interruptions: n });
    expect(transition(job, { type: "interruption_limit" }, NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });

  it("interruptionsExhausted mirrors the limit", () => {
    expect(interruptionsExhausted(aReviewJobInState("running", { interruptions: 2 }))).toBe(false);
    expect(interruptionsExhausted(aReviewJobInState("running", { interruptions: 3 }))).toBe(true);
    expect(interruptionsExhausted(aReviewJobInState("running", { interruptions: 4 }))).toBe(true);
    expect(interruptionsExhausted(aReviewJobInState("running"))).toBe(false);
  });
});

describe("checkpoint", () => {
  const run = (patch: Partial<UrlProgress>, job = aReviewJobInState("running"), url = URL1) =>
    transition(job, { type: "checkpoint", url, patch }, NOW);
  const review = { summary: "s", findings: [], verificationRequests: [] };

  it("rejects an unknown url", () => {
    expect(run({ reviewed: true }, undefined, "https://x/y")).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "url" },
    });
  });
  it("never lets a true flag go back to false", () => {
    const job = aReviewJobInState("running", { progress: { [URL1]: { reviewed: true } } });
    expect(run({ reviewed: false }, job)).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });
  it.each([
    ["commentId", 1, 2],
    ["githubReviewId", 1, 2],
  ] as const)("%s is write-once", (key, a, b) => {
    const job = aReviewJobInState("running", { progress: { [URL1]: { [key]: a } } });
    expect(run({ [key]: b }, job)).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(run({ [key]: a }, job).ok).toBe(true); // re-saving the same value is idempotent
    expect(run({ [key]: undefined }, job)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });
  it("review is write-once", () => {
    const job = aReviewJobInState("running", { progress: { [URL1]: { review } } });
    expect(run({ review: { ...review, summary: "other" } }, job)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });
  it("batchReview may be dropped when a fresh review starts", () => {
    const job = aReviewJobInState("running", {
      progress: { [URL1]: { batchReview: { fingerprint: "f", total: 1, results: [] } } },
    });
    const r = run({ batchReview: undefined }, job);
    expect(r.ok && r.value.progress[URL1]).toEqual({});
  });
  it("the first review resets the interruption counter, later checkpoints do not", () => {
    const job = aReviewJobInState("running", { interruptions: 2 });
    const first = run({ review }, job);
    expect(first.ok && first.value.interruptions).toBe(0);
    const again = transition(
      { ...aReviewJobInState("running", { interruptions: 2, progress: { [URL1]: { review } } }) },
      { type: "checkpoint", url: URL1, patch: { commented: true } },
      NOW,
    );
    expect(again.ok && again.value.interruptions).toBe(2);
  });
  it("rejects an invalid merged progress (fail closed)", () => {
    const r = run({ commentId: -3 });
    expect(r).toMatchObject({ ok: false, error: { kind: "validation" } });
  });
  it("rejects checkpoints for a completed url", () => {
    const job = aReviewJobInState("running", { progress: { [URL1]: { completed: true } } });
    expect(run({ commented: true }, job)).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });
  it.each(["completed", "approve", "recorded"])(
    "rejects setting `%s` through a checkpoint",
    (key) => {
      expect(run({ [key]: true } as Partial<UrlProgress>)).toMatchObject({
        ok: false,
        error: { kind: "conflict" },
      });
    },
  );
});

describe("url_completed / all_completed", () => {
  const two = (progress: ReviewJob["progress"], source: ReviewJob["source"] = "slack") =>
    aReviewJobInState("running", { urls: [URL1, URL2], progress, source });

  it("completes URLs one by one and rejects a duplicate or unknown url", () => {
    const a = transition(two({}), { type: "url_completed", url: URL1 }, NOW);
    expect(a.ok && a.value.progress).toEqual({ [URL1]: { completed: true } });
    if (!a.ok) return;
    expect(transition(a.value, { type: "url_completed", url: URL1 }, NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
    expect(transition(a.value, { type: "url_completed", url: "nope" }, NOW)).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
  });
  it("all_completed needs every URL", () => {
    expect(
      transition(two({ [URL1]: { completed: true } }), { type: "all_completed" }, NOW),
    ).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });
  it("slack goes straight to done too (no reaction step) and releases the lease", () => {
    const r = transition(
      two({ [URL1]: { completed: true }, [URL2]: { completed: true } }),
      { type: "all_completed" },
      NOW,
    );
    expect(r).toMatchObject({
      ok: true,
      value: { state: "done", leaseOwner: null, leaseUntil: null },
    });
  });
  it("web goes straight to done and releases the lease", () => {
    const r = transition(
      two({ [URL1]: { completed: true }, [URL2]: { completed: true } }, "web"),
      { type: "all_completed" },
      NOW,
    );
    expect(r).toMatchObject({
      ok: true,
      value: { state: "done", leaseOwner: null, leaseUntil: null },
    });
  });
  it("a job without urls cannot complete", () => {
    const job = aReviewJobInState("running", { urls: [], progress: {} });
    expect(transition(job, { type: "all_completed" }, NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });
});

describe("deferred / reply_sent / retry", () => {
  it("deferred may carry a retry time, which may not be in the past", () => {
    const job = aReviewJobInState("running");
    expect(transition(job, { type: "deferred", retryAt: ms(5000) }, NOW)).toMatchObject({
      ok: true,
      value: { state: "queued", nextAttemptAt: ms(5000) },
    });
    expect(transition(job, { type: "deferred", retryAt: ms(-1) }, NOW)).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
  });
  it("deferred keeps checkpoints and the interruption counter and clears lastError", () => {
    const job = aReviewJobInState("running", {
      interruptions: 1,
      lastError: "x",
      progress: { [URL1]: { reviewed: true } },
    });
    const r = transition(job, { type: "deferred" }, NOW);
    expect(r.ok && r.value).toMatchObject({
      interruptions: 1,
      progress: { [URL1]: { reviewed: true } },
    });
    expect(r.ok && r.value.lastError).toBeUndefined();
  });
  it("reply_sent is at most once", () => {
    const job = aReviewJobInState("done", { resultReplySent: true });
    expect(transition(job, { type: "reply_sent" }, NOW)).toMatchObject({
      ok: false,
      error: { kind: "conflict" },
    });
  });
  it("retry clears error, schedule, interruptions and the reply flag but keeps checkpoints and attempts", () => {
    const job = aReviewJobInState("failed", {
      resultReplySent: true,
      interruptions: 3,
      nextAttemptAt: ms(9),
      progress: { [URL1]: { reviewed: true } },
      attempts: 4,
    });
    const r = transition(job, { type: "retry" }, NOW);
    expect(r.ok && r.value).toMatchObject({
      state: "queued",
      attempts: 4,
      progress: { [URL1]: { reviewed: true } },
      nextAttemptAt: null,
    });
    expect(r.ok && r.value.lastError).toBeUndefined();
    expect(r.ok && r.value.interruptions).toBeUndefined();
    expect(r.ok && r.value.resultReplySent).toBeUndefined();
  });
});

it("builder sanity: aReviewJob is slack by default", () => {
  expect(aReviewJob().source).toBe("slack");
});

it("an unknown event type is a validation error, never a throw", () => {
  const r = transition(aReviewJobInState("running"), { type: "nope" } as never, NOW);
  expect(r).toMatchObject({ ok: false, error: { kind: "validation", field: "type" } });
});
