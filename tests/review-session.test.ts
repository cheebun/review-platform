import assert from "node:assert/strict";
import { test } from "vitest";
import { runReviewSession, type ReviewSessionStore } from "../src/lib/review-session";
import { ReviewDeferredError } from "../src/lib/review-input";
import type { ExecuteResult } from "../src/lib/types";

const url = "https://github.com/bosinc/katana-web/pull/17240";
const result: ExecuteResult = {
  mode: "ship",
  pr: {
    owner: "bosinc",
    repo: "katana-web",
    number: 17240,
    title: "Large PR",
    author: "tian-1m",
    htmlUrl: url,
    base: "main",
    head: "branch",
  },
  review: { summary: "Reviewed", findings: [], verificationRequests: ["Run tests"] },
  highestSeverity: null,
  approved: true,
  merged: false,
  githubEvent: "APPROVE",
  reviewCommentBody: "Reviewed",
};

function memoryStore(): ReviewSessionStore {
  const records = new Map<string, string>();
  const locks = new Set<string>();
  return {
    async get(id) {
      return records.has(id) ? JSON.parse(records.get(id)!) : null;
    },
    async save(id, session) {
      records.set(id, JSON.stringify(session));
    },
    async acquire(id) {
      if (locks.has(id)) return null;
      locks.add(id);
      return async () => {
        locks.delete(id);
      };
    },
  };
}

test("browser continuations keep progress server-side and return the completed result once", async () => {
  const store = memoryStore();
  const pending = await runReviewSession({
    url,
    account: "zhiyong-eng",
    store,
    startReviewBefore: 0,
    ship: async (_url, _account, options) => {
      options!.progress!.review = result.review;
      await options!.checkpoint!(options!.progress!);
      throw new ReviewDeferredError();
    },
  });
  assert.equal(pending.pending, true);
  if (!pending.pending) return;
  assert.equal("progress" in pending, false);
  const resumed = await runReviewSession({
    url,
    account: "zhiyong-eng",
    store,
    sessionId: pending.sessionId,
    startReviewBefore: Infinity,
    ship: async (_url, _account, options) => {
      assert.equal(options!.progress!.review!.summary, result.review.summary);
      assert.equal(options!.requestId, `ui:${pending.sessionId}`);
      return result;
    },
  });
  assert.deepEqual(resumed, { pending: false, result });
  const duplicate = await runReviewSession({
    url,
    account: "zhiyong-eng",
    store,
    sessionId: pending.sessionId,
    startReviewBefore: Infinity,
    ship: async () => {
      throw new Error("Completed review must not run again");
    },
  });
  assert.deepEqual(duplicate, resumed);
});

test("sessions bind to the PR and account and reject arbitrary session IDs", async () => {
  const store = memoryStore();
  const pending = await runReviewSession({
    url,
    account: "zhiyong-eng",
    store,
    startReviewBefore: 0,
    ship: async () => {
      throw new ReviewDeferredError();
    },
  });
  if (!pending.pending) throw new Error("Expected a pending session");
  const base = {
    url,
    account: "zhiyong-eng" as const,
    store,
    sessionId: pending.sessionId,
    startReviewBefore: Infinity,
    ship: async () => {
      throw new Error("Must not run");
    },
  };
  await assert.rejects(runReviewSession({ ...base, account: "wgbx" }), /不匹配/);
  await assert.rejects(runReviewSession({ ...base, url: url.replace("17240", "17241") }), /不匹配/);
  await assert.rejects(runReviewSession({ ...base, sessionId: "../../invalid" }), /ID 无效/);
  // Failed validation releases the lock, so the original session can still continue.
  assert.deepEqual(await runReviewSession({ ...base, ship: async () => result }), {
    pending: false,
    result,
  });
});

test("overlapping browser continuations never run Ship concurrently", async () => {
  const store = memoryStore();
  const pending = await runReviewSession({
    url,
    account: "zhiyong-eng",
    store,
    startReviewBefore: 0,
    ship: async () => {
      throw new ReviewDeferredError();
    },
  });
  if (!pending.pending) throw new Error("Expected a pending session");
  const release = await store.acquire(pending.sessionId);
  assert.ok(release);
  const busy = await runReviewSession({
    url,
    account: "zhiyong-eng",
    store,
    sessionId: pending.sessionId,
    startReviewBefore: Infinity,
    ship: async () => {
      throw new Error("Locked review must not run");
    },
  });
  assert.deepEqual(busy, pending);
  await release();
});
