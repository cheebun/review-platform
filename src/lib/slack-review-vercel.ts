import type { WebClient } from "@slack/web-api";
import { after } from "next/server";
import {
  createSlackClient,
  fetchSlackIdentity,
  readSlackReviewConfig,
  slackReviewDependencies,
} from "./slack-review-config";
import { drainSlackReviewJobs } from "./slack-review-queue";
import { createSlackReviewRedisQueue } from "./slack-review-redis";

// Leave room for the last started review inside the 300s route maxDuration.
const START_NEW_JOBS_WITHIN_MS = 90_000;

let identity: ReturnType<typeof fetchSlackIdentity> | undefined;

export function slackReviewRuntime() {
  const config = readSlackReviewConfig();
  const slack = createSlackClient(config);
  return {
    config,
    slack,
    queue: createSlackReviewRedisQueue(),
    dependencies: slackReviewDependencies(config, slack),
  };
}

export type SlackReviewRuntime = ReturnType<typeof slackReviewRuntime>;

/** Cached per warm instance so ordinary Slack messages do not call auth.test every time. */
export function slackIdentity(slack: WebClient) {
  identity ??= fetchSlackIdentity(slack).catch((error: unknown) => {
    identity = undefined;
    throw error;
  });
  return identity;
}

export function runSlackReviewQueue(runtime: SlackReviewRuntime, firstId?: string) {
  return drainSlackReviewJobs(runtime.queue, runtime.dependencies, {
    firstId,
    startBefore: Date.now() + START_NEW_JOBS_WITHIN_MS,
  }).catch((error: unknown) => {
    console.error(
      "[slack-review] 队列执行失败：",
      error instanceof Error ? error.message : "未知错误",
    );
  });
}

/** Keeps the function alive after the response so Slack gets its acknowledgement within 3 seconds. */
export function scheduleSlackReviewQueue(runtime: SlackReviewRuntime, firstId?: string) {
  after(() => runSlackReviewQueue(runtime, firstId));
}
