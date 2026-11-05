/**
 * FR-SLACK-03 / FR-SLACK-05: a matched mention becomes a queued review job. Order: job (its id
 * from `team:channel:ts` is the second dedupe layer) → thread index + ⏳ in one transaction →
 * wake the consumer → `on it`. A duplicate job stops before any side effect.
 */
import { createHash } from "node:crypto";
import { initialProgress } from "../../domain/review-queue/state-machine";
import { matchSlackReviewMessage, type SlackReviewMessage } from "../../domain/slack/review-rules";
import { ok } from "../../domain/shared/result";
import { REVIEW_JOB_WAKE_CHANNEL } from "../review/ports";
import { acceptedTarget, nextRound } from "../review/reaction-target";
import {
  ingestConfig,
  replyInThread,
  wakeConsumer,
  type IngestContext,
  type SlackIngestDeps,
} from "./context";
import { REPLY } from "./replies";

/** Stable job id of a Slack request: sha256 of its dedupe seed (same as the legacy id). */
export const slackJobId = (seed: string): string => createHash("sha256").update(seed).digest("hex");

/** Per-sender limit (S6). Over the limit: no job, no reply, logged (FR-SLACK-04 AC2). */
export async function senderAllowed(
  deps: SlackIngestDeps,
  sender: string,
  purpose: "review",
): Promise<boolean> {
  const limit = await deps.rateLimiter.hit(
    `slack-${purpose}:${sender}`,
    ingestConfig(deps).senderLimit,
  );
  if (!limit.allowed) deps.review.logger.warn("slack review rate limited", { sender });
  return limit.allowed;
}

async function match(
  deps: SlackIngestDeps,
  ctx: IngestContext,
): Promise<SlackReviewMessage | null> {
  const [repoList, channels] = await Promise.all([
    deps.review.repoList(),
    deps.settingsStore.listReviewChannels(),
  ]);
  return matchSlackReviewMessage(ctx.payload, {
    userId: ctx.owner.userId,
    teamId: ctx.owner.teamId,
    repoList,
    channelIds: channels.map((c) => c.channelId),
    activeHours: ingestConfig(deps).activeHours,
  });
}

export async function runIntake(deps: SlackIngestDeps, ctx: IngestContext): Promise<void> {
  const { jobs, threads, uow, logger } = deps.review;
  const msg = await match(deps, ctx);
  if (!msg) {
    logger.debug("slack message did not match the review rules", { eventId: ctx.eventId });
    return;
  }
  const threadKey = { channel: msg.channel, threadTs: msg.threadTs ?? msg.ts };
  const before = await threads.get(threadKey);
  if (msg.threadTs && before) {
    // The thread already has a review: re-reviews go through `updated` / `review`.
    logger.info("mention in a reviewed thread ignored", { channel: msg.channel });
    return;
  }
  if (!(await senderAllowed(deps, msg.sender, "review"))) return;

  const id = slackJobId(msg.key);
  const created = await jobs.create({
    id,
    source: "slack",
    state: "queued",
    urls: msg.urls,
    progress: initialProgress(msg.urls, () => null),
    slack: {
      channel: msg.channel,
      ts: msg.ts,
      ...(msg.threadTs ? { threadTs: msg.threadTs } : {}),
      user: msg.sender,
    },
  });
  if (!created.ok) {
    if (created.error.kind === "conflict") {
      logger.info("slack review already enqueued", { jobId: id });
    } else {
      logger.error("slack review job not created", { jobId: id, error: created.error.kind });
    }
    return;
  }

  const round = nextRound(before);
  const recorded = await uow.run(async (tx) => {
    const thread = await tx.recordThreadReview({
      ...threadKey,
      prUrls: msg.urls,
      requesterSlackId: msg.sender,
      reviewId: id,
      statusMessageTs: msg.ts,
    });
    if (!thread.ok) return thread;
    const queued = await tx.enqueueReaction(
      acceptedTarget({
        channel: msg.channel,
        ts: msg.ts,
        prUrl: msg.urls[0]!,
        round,
        reviewId: id,
      }),
    );
    if (!queued.ok) return queued;
    return ok(undefined);
  });
  if (!recorded.ok) {
    // The job still runs; only the thread lookup and ⏳ are missing.
    logger.error("thread index or ⏳ not recorded", { jobId: id, error: recorded.error.kind });
  }

  await wakeConsumer(deps, REVIEW_JOB_WAKE_CHANNEL);
  await replyInThread(deps, threadKey, REPLY.onIt, "on it reply failed");
}
