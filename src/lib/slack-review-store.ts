import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GithubAccount } from "./accounts";
import type { SlackReviewMessage } from "./slack-review-rules";
import type { ShipProgress } from "./ship-pr";

export type SlackReviewStatus = "queued" | "running" | "reaction_pending" | "done" | "failed";
export type SlackReviewJob = SlackReviewMessage & {
  account: GithubAccount;
  status: SlackReviewStatus;
  createdAt: string;
  updatedAt: string;
  progress: Record<string, ShipProgress>;
  error?: string;
  nextAttemptAt?: number;
  /** Final Slack result or failure reply was sent before the ✅ reaction. */
  resultReplySent?: boolean;
  /** Runs that ended without saving a final status, e.g. a serverless timeout. */
  interruptions?: number;
};
export type SlackReviewState = {
  version: 1;
  worker?: { connected: boolean; updatedAt: string; userId: string; account: GithubAccount };
  jobs: SlackReviewJob[];
};

export function slackReviewStatePath() {
  const configured = process.env.SLACK_REVIEW_STATE_FILE?.trim();
  // This file is runtime state on a persistent disk, rather than a deploy-time asset.
  return configured
    ? resolve(/*turbopackIgnore: true*/ configured)
    : join(process.cwd(), ".agent-ops", "slack-review.json");
}

export async function readSlackReviewState(
  file = slackReviewStatePath(),
): Promise<SlackReviewState> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] };
    throw error;
  }
  const state = JSON.parse(raw) as SlackReviewState;
  const statuses: SlackReviewStatus[] = ["queued", "running", "reaction_pending", "done", "failed"];
  if (
    state.version !== 1 ||
    !Array.isArray(state.jobs) ||
    state.jobs.some(
      (job) =>
        !job ||
        typeof job.id !== "string" ||
        !statuses.includes(job.status) ||
        !Array.isArray(job.urls) ||
        !job.urls.length ||
        job.urls.some((url) => typeof url !== "string") ||
        !job.progress ||
        typeof job.progress !== "object",
    )
  ) {
    throw new Error("Slack Review 状态文件无效，已停止处理以避免重复执行。");
  }
  return state;
}

export class SlackReviewStore {
  private writes = Promise.resolve();
  private enqueues = Promise.resolve();
  private accepting = new Set<string>();
  constructor(
    public state: SlackReviewState,
    private file: string,
  ) {}

  static async open(file = slackReviewStatePath(), retryFailed = false) {
    const state = await readSlackReviewState(file);
    for (const job of state.jobs) {
      if (job.status === "running" || (retryFailed && job.status === "failed")) {
        job.status = "queued";
        job.error = undefined;
        job.nextAttemptAt = undefined;
      }
    }
    const store = new SlackReviewStore(state, file);
    await store.save();
    return store;
  }

  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    // Each caller still receives the error; a failed disk write cannot silently acknowledge an event.
    this.writes = write.catch(() => {});
    return write;
  }

  nextJob(now = Date.now()) {
    return this.state.jobs.find(
      (job) =>
        !this.accepting.has(job.id) &&
        (job.status === "queued" || job.status === "reaction_pending") &&
        (!job.nextAttemptAt || job.nextAttemptAt <= now),
    );
  }

  enqueue(message: SlackReviewMessage, account: GithubAccount) {
    const operation = this.enqueues.then(async () => {
      if (this.state.jobs.some((job) => job.id === message.id)) return false;
      const now = new Date().toISOString();
      const job: SlackReviewJob = {
        ...message,
        account,
        status: "queued",
        progress: {},
        createdAt: now,
        updatedAt: now,
      };
      this.state.jobs.push(job);
      this.accepting.add(job.id);
      try {
        await this.save();
      } catch (error) {
        this.state.jobs = this.state.jobs.filter((item) => item !== job);
        throw error;
      } finally {
        this.accepting.delete(job.id);
      }
      return true;
    });
    this.enqueues = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
