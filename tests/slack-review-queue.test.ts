import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vitest";
import {
  drainSlackReviewJobs,
  newSlackReviewJob,
  processSlackReviewJob,
  retryFailedSlackReviewJobs,
  visibleSlackReviewJobs,
  type SlackReviewQueue,
} from "../src/lib/slack-review-queue";
import type { RunnerDependencies } from "../src/lib/slack-review-runner";
import type { SlackReviewJob } from "../src/lib/slack-review-store";
import { verifySlackSignature } from "../src/lib/slack-signature";
import { ReviewDeferredError } from "../src/lib/review-input";

const url = "https://github.com/bosinc/katana-web/pull/17190";

class MemoryQueue implements SlackReviewQueue {
  jobs = new Map<string, string>();
  locks = new Map<string, string>();
  async create(job: SlackReviewJob) {
    if (this.jobs.has(job.id)) return false;
    this.jobs.set(job.id, JSON.stringify(job));
    return true;
  }
  async get(id: string) {
    const raw = this.jobs.get(id);
    return raw ? (JSON.parse(raw) as SlackReviewJob) : null;
  }
  async save(job: SlackReviewJob) {
    this.jobs.set(job.id, JSON.stringify(job));
  }
  async pending() {
    return [...this.jobs.values()]
      .map((raw) => JSON.parse(raw) as SlackReviewJob)
      .filter((job) => job.status !== "done" && job.status !== "failed");
  }
  async recent() {
    return [...this.jobs.values()].map((raw) => JSON.parse(raw) as SlackReviewJob);
  }
  async lock(id: string, token: string) {
    if (this.locks.has(id)) return false;
    this.locks.set(id, token);
    return true;
  }
  async unlock(id: string, token: string) {
    if (this.locks.get(id) === token) this.locks.delete(id);
  }
  async throttle() {
    return true;
  }
  read: string | null = null;
  async readBefore() {
    return this.read;
  }
  async markRead(at: string) {
    this.read = at;
  }
  readIds: string[] = [];
  async readJobs() {
    return this.readIds;
  }
  async markJobRead(id: string) {
    this.readIds.push(id);
  }
}

function job(id: string, createdAt = "2026-10-15T00:00:00.000Z") {
  return {
    ...newSlackReviewJob(
      { id, channel: "C1", ts: "1.000001", sender: "U_YETIAN", urls: [url] },
      "zhiyong-eng",
    ),
    createdAt,
  };
}

function dependencies(calls: string[]): RunnerDependencies {
  return {
    senderIds: ["U_YETIAN"],
    ship: async (pr) => {
      calls.push(`ship:${pr}`);
    },
    react: async (_channel, ts) => {
      calls.push(`react:${ts}`);
    },
  };
}

test("verifies Slack signatures and rejects tampering or stale timestamps", () => {
  const secret = "secret";
  const body = '{"type":"event_callback"}';
  const timestamp = "1760000000";
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const now = Number(timestamp) * 1000;
  assert.equal(verifySlackSignature({ secret, body, timestamp, signature, now }), true);
  assert.equal(
    verifySlackSignature({ secret, body: `${body} `, timestamp, signature, now }),
    false,
  );
  assert.equal(verifySlackSignature({ secret: "other", body, timestamp, signature, now }), false);
  assert.equal(
    verifySlackSignature({ secret, body, timestamp, signature, now: now + 301_000 }),
    false,
  );
  assert.equal(verifySlackSignature({ secret, body, timestamp: null, signature, now }), false);
  assert.equal(
    verifySlackSignature({ secret, body, timestamp, signature: "v0=short", now }),
    false,
  );
});

test("duplicate Slack deliveries create one job and a locked job is not run twice", async () => {
  const queue = new MemoryQueue();
  assert.equal(await queue.create(job("a")), true);
  assert.equal(await queue.create(job("a")), false);
  const calls: string[] = [];
  await queue.lock("a", "other-instance");
  assert.equal(await processSlackReviewJob(queue, "a", dependencies(calls)), false);
  assert.deepEqual(calls, []);
  await queue.unlock("a", "other-instance");
  assert.equal(await processSlackReviewJob(queue, "a", dependencies(calls)), true);
  assert.deepEqual(calls, [`ship:${url}`, "react:1.000001"]);
  assert.equal((await queue.get("a"))!.status, "done");
  assert.equal(queue.locks.size, 0);
  assert.equal(await processSlackReviewJob(queue, "a", dependencies(calls)), false);
});

test("resumes interrupted jobs from checkpoints and gives up after repeated interruptions", async () => {
  const queue = new MemoryQueue();
  const interrupted = {
    ...job("a"),
    status: "running" as const,
    progress: { [url]: { commentId: 42 } },
  };
  await queue.create(interrupted);
  let seen: number | undefined;
  await processSlackReviewJob(queue, "a", {
    ...dependencies([]),
    ship: async (_pr, _account, { progress }) => {
      seen = progress.commentId;
    },
  });
  assert.equal(seen, 42);
  assert.equal((await queue.get("a"))!.status, "done");

  await queue.create({ ...job("b"), status: "running", interruptions: 2 });
  const calls: string[] = [];
  await processSlackReviewJob(queue, "b", dependencies(calls));
  const failed = (await queue.get("b"))!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /中断/);
  assert.deepEqual(calls, []);
});

test("drain runs the new job first, then older pending jobs, and skips future reaction retries", async () => {
  const queue = new MemoryQueue();
  await queue.create({ ...job("old", "2026-10-14T00:00:00.000Z"), ts: "1.000002" });
  await queue.create({
    ...job("later", "2026-10-14T01:00:00.000Z"),
    status: "reaction_pending",
    nextAttemptAt: Date.now() + 60_000,
  });
  await queue.create({ ...job("new"), ts: "1.000003" });
  const calls: string[] = [];
  await drainSlackReviewJobs(queue, dependencies(calls), {
    firstId: "new",
    startBefore: Date.now() + 60_000,
  });
  assert.deepEqual(calls, [`ship:${url}`, "react:1.000003", `ship:${url}`, "react:1.000002"]);
  assert.equal((await queue.get("later"))!.status, "reaction_pending");

  const late: string[] = [];
  await queue.create({ ...job("stale"), ts: "1.000004" });
  await drainSlackReviewJobs(queue, dependencies(late), { startBefore: Date.now() - 1 });
  assert.deepEqual(late, []);
});

test("marking read hides finished jobs only, and later updates show again", async () => {
  const queue = new MemoryQueue();
  const at = (minute: number) => `2026-10-15T02:${String(minute).padStart(2, "0")}:00.000Z`;
  await queue.create({ ...job("done"), status: "done", updatedAt: at(1) });
  await queue.create({ ...job("failed"), status: "failed", updatedAt: at(2) });
  await queue.create({ ...job("running"), status: "running", updatedAt: at(3) });
  await queue.markRead(at(5));
  await queue.create({ ...job("later"), status: "done", updatedAt: at(6) });
  assert.deepEqual((await visibleSlackReviewJobs(queue, 10)).map((item) => item.id).sort(), [
    "later",
    "running",
  ]);
});

test("marking one job read hides only that finished job", async () => {
  const queue = new MemoryQueue();
  await queue.create({ ...job("done"), status: "done" });
  await queue.create({ ...job("failed"), status: "failed", ts: "1.000002" });
  await queue.create({ ...job("running"), status: "running", ts: "1.000003" });
  await queue.markJobRead("done");
  await queue.markJobRead("running");
  assert.deepEqual((await visibleSlackReviewJobs(queue, 10)).map((item) => item.id).sort(), [
    "failed",
    "running",
  ]);
});

test("manual retry requeues failed jobs and keeps checkpoints", async () => {
  const queue = new MemoryQueue();
  await queue.create({
    ...job("a"),
    status: "failed",
    error: "boom",
    interruptions: 3,
    progress: { [url]: { commentId: 7 } },
  });
  await queue.create({ ...job("b"), status: "done" });
  assert.equal(await retryFailedSlackReviewJobs(queue), 1);
  const retried = (await queue.get("a"))!;
  assert.equal(retried.status, "queued");
  assert.equal(retried.error, undefined);
  assert.equal(retried.interruptions, undefined);
  assert.equal(retried.progress[url].commentId, 7);
  assert.equal((await queue.get("b"))!.status, "done");
});

test("deferral keeps the job queued without a Slack reaction and resumes its saved review", async () => {
  const queue = new MemoryQueue();
  await queue.create({ ...job("batches"), status: "running", interruptions: 1 });
  const calls: string[] = [];
  const deadline = Date.now() + 90_000;
  await drainSlackReviewJobs(
    queue,
    {
      ...dependencies(calls),
      ship: async (_url, _account, options) => {
        assert.equal(options.startReviewBefore, deadline);
        options.progress.review = {
          summary: "Full review",
          findings: [],
          verificationRequests: ["Run tests"],
        };
        await options.checkpoint(options.progress);
        throw new ReviewDeferredError();
      },
    },
    { firstId: "batches", startBefore: deadline },
  );
  const deferred = (await queue.get("batches"))!;
  assert.equal(deferred.status, "queued");
  assert.equal(deferred.error, undefined);
  assert.equal(deferred.interruptions, 0);
  assert.equal(deferred.progress[url].review?.summary, "Full review");
  assert.deepEqual(calls, []);
  await processSlackReviewJob(queue, "batches", {
    ...dependencies(calls),
    ship: async (_url, _account, options) => {
      assert.equal(options.progress.review?.summary, "Full review");
    },
  });
  assert.equal((await queue.get("batches"))!.status, "done");
  assert.deepEqual(calls, ["react:1.000001"]);
});
