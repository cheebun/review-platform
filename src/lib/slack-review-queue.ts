import { randomUUID } from "node:crypto";
import type { GithubAccount } from "./accounts";
import type { SlackReviewMessage } from "./slack-review-rules";
import { runSlackReviewJob, type RunnerDependencies } from "./slack-review-runner";
import type { SlackReviewJob } from "./slack-review-store";

/** Shared job storage for stateless deployments; every instance sees the same jobs and locks. */
export interface SlackReviewQueue {
  /** Atomically creates the job; false when the Slack message was already accepted. */
  create(job: SlackReviewJob): Promise<boolean>;
  get(id: string): Promise<SlackReviewJob | null>;
  save(job: SlackReviewJob): Promise<void>;
  /** Jobs that are not done / failed. */
  pending(): Promise<SlackReviewJob[]>;
  recent(limit: number): Promise<SlackReviewJob[]>;
  lock(id: string, token: string, ttlMs: number): Promise<boolean>;
  unlock(id: string, token: string): Promise<void>;
  /** True at most once per window, across instances. */
  throttle(name: string, seconds: number): Promise<boolean>;
  /** Finished jobs last updated at or before this ISO time are hidden from the status list. */
  readBefore(): Promise<string | null>;
  markRead(at: string): Promise<void>;
  /** Finished jobs hidden one by one. */
  readJobs(): Promise<string[]>;
  markJobRead(id: string): Promise<void>;
}

export function isFinishedSlackReviewJob(job: SlackReviewJob) {
  return job.status === "done" || job.status === "failed";
}

export async function visibleSlackReviewJobs(queue: SlackReviewQueue, limit: number) {
  const [jobs, readBefore, readJobs] = await Promise.all([
    queue.recent(limit * 3),
    queue.readBefore(),
    queue.readJobs(),
  ]);
  const read = new Set(readJobs);
  return jobs
    .filter(
      (job) =>
        !isFinishedSlackReviewJob(job) ||
        (!read.has(job.id) && (!readBefore || job.updatedAt > readBefore)),
    )
    .slice(0, limit);
}

// Must exceed the route maxDuration, so an expired lock means its holder was terminated.
export const SLACK_REVIEW_LOCK_MS = 330_000;
const MAX_INTERRUPTIONS = 3;

export function newSlackReviewJob(
  message: SlackReviewMessage,
  account: GithubAccount,
): SlackReviewJob {
  const now = new Date().toISOString();
  return { ...message, account, status: "queued", progress: {}, createdAt: now, updatedAt: now };
}

function runnable(job: SlackReviewJob, now: number) {
  if (job.status === "queued" || job.status === "running") return true;
  return job.status === "reaction_pending" && (!job.nextAttemptAt || job.nextAttemptAt <= now);
}

/** Returns true when this call owned the job and ran it. */
export async function processSlackReviewJob(
  queue: SlackReviewQueue,
  id: string,
  dependencies: RunnerDependencies,
) {
  const token = randomUUID();
  if (!(await queue.lock(id, token, SLACK_REVIEW_LOCK_MS))) return false;
  try {
    const job = await queue.get(id);
    if (!job || !runnable(job, Date.now())) return false;
    // Holding the lock while the job says "running" means the previous run was killed mid-way.
    if (job.status === "running") {
      job.interruptions = (job.interruptions ?? 0) + 1;
      if (job.interruptions >= MAX_INTERRUPTIONS) {
        job.status = "failed";
        job.error = `执行连续中断 ${job.interruptions} 次（可能超出函数时长限制），已停止自动重试。`;
        job.updatedAt = new Date().toISOString();
        await queue.save(job);
        return true;
      }
    }
    await runSlackReviewJob({ save: () => queue.save(job) }, job, dependencies);
    return true;
  } finally {
    await queue.unlock(id, token);
  }
}

/** Runs the given job first, then resumes other unfinished jobs while time remains. */
export async function drainSlackReviewJobs(
  queue: SlackReviewQueue,
  dependencies: RunnerDependencies,
  options: { firstId?: string; startBefore: number },
) {
  const bounded = { ...dependencies, startReviewBefore: options.startBefore };
  if (options.firstId) await processSlackReviewJob(queue, options.firstId, bounded);
  const jobs = (await queue.pending())
    .filter((job) => job.id !== options.firstId && runnable(job, Date.now()))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of jobs) {
    if (Date.now() >= options.startBefore) break;
    await processSlackReviewJob(queue, job.id, bounded);
  }
}

export async function retryFailedSlackReviewJobs(queue: SlackReviewQueue, limit = 100) {
  let count = 0;
  for (const job of await queue.recent(limit)) {
    if (job.status !== "failed") continue;
    job.status = "queued";
    job.error = undefined;
    job.nextAttemptAt = undefined;
    job.interruptions = undefined;
    job.updatedAt = new Date().toISOString();
    await queue.save(job);
    count++;
  }
  return count;
}
