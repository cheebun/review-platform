/**
 * Thread commands (FR-SLACK-13, FR-SLACK-14). The thread is looked up in the
 * `ThreadReviewIndex`; an unknown thread or an unauthorised sender does nothing and is logged.
 * Every reply goes into the thread, posted as the owner.
 *
 * - `review` (owner) and `updated` (requester): a new review round on the original message, ⏳
 *   via the outbox with `round = nextRound(thread)`.
 * - `approve`, `force approve`, `merge` (owner): the ship use cases, one PR per thread (Q16).
 */
import { parsePrUrl } from "../../domain/github/pr-ref";
import { initialProgress } from "../../domain/review-queue/state-machine";
import type { Actor } from "../../domain/shared/actor";
import { ok } from "../../domain/shared/result";
import { withinActiveHours } from "../../domain/slack/review-rules";
import { parseThreadCommand, type ThreadCommandName } from "../../domain/slack/thread-command";
import type { ThreadReview } from "../../ports/thread-review-index";
import { REVIEW_JOB_WAKE_CHANNEL } from "../review/ports";
import { acceptedTarget, nextRound } from "../review/reaction-target";
import { approvePr, forceApprovePr, mergePr } from "../ship/ship";
import {
  ingestConfig,
  replyInThread,
  wakeConsumer,
  type IngestContext,
  type SlackIngestDeps,
} from "./context";
import { senderAllowed, slackJobId } from "./intake";
import {
  approveReply,
  forceApproveReply,
  mergeRefusedReply,
  mergeReply,
  REPLY,
  refusedReply,
  reReviewReply,
  whichPrReply,
} from "./replies";

export type CommandCandidate = {
  command: ThreadCommandName;
  event: { user: string; ts: string; thread_ts?: string | undefined; channel: string };
  /** `updated`: the sender must still be checked against the thread's requester. */
  needsRequester: boolean;
};

type Where = { channel: string; threadTs: string };

const rawEventOf = (payload: unknown): unknown =>
  payload && typeof payload === "object" ? (payload as { event?: unknown }).event : undefined;

/** The owner as a ship actor. The id is namespaced so it never collides with a web user id. */
export const slackOwnerActor = (ownerSlackId: string): Actor => ({
  kind: "user",
  userId: `slack:${ownerSlackId}`,
  email: "",
});

export async function runThreadCommand(
  deps: SlackIngestDeps,
  ctx: IngestContext,
  candidate: CommandCandidate,
): Promise<void> {
  const { logger, threads } = deps.review;
  const { event, command } = candidate;
  if (!event.thread_ts) return;
  const thread = await threads.get({ channel: event.channel, threadTs: event.thread_ts });
  if (!thread) {
    logger.info("thread command for an unknown thread", {
      command,
      sender: event.user,
      channel: event.channel,
    });
    return;
  }
  if (candidate.needsRequester) {
    const parsed = parseThreadCommand(rawEventOf(ctx.payload), {
      ownerId: ctx.owner.userId,
      requesterId: thread.requesterSlackId,
    });
    if (parsed.kind !== "command") {
      logger.info("thread command ignored", {
        sender: event.user,
        reason: parsed.reason,
        channel: event.channel,
      });
      return;
    }
  }
  const where = { channel: thread.channel, threadTs: thread.threadTs };
  switch (command) {
    case "review":
    case "updated":
      return reReview(deps, ctx, candidate, thread, where);
    case "approve":
    case "force_approve":
    case "merge":
      return ship(deps, ctx, command, thread, where);
  }
}

async function ship(
  deps: SlackIngestDeps,
  ctx: IngestContext,
  command: "approve" | "force_approve" | "merge",
  thread: ThreadReview,
  where: Where,
): Promise<void> {
  if (thread.prUrls.length !== 1) {
    await replyInThread(deps, where, whichPrReply(thread.prUrls));
    return;
  }
  const prUrl = thread.prUrls[0]!;
  const req = { actor: slackOwnerActor(ctx.owner.userId), prUrl, source: "slack" as const };
  let text: string;
  if (command === "approve") {
    const r = await approvePr(deps.review, req);
    text = r.ok ? approveReply(prUrl, r.value) : refusedReply("approve", prUrl, r.error);
  } else if (command === "force_approve") {
    const r = await forceApprovePr(deps.review, req);
    text = r.ok ? forceApproveReply(prUrl, r.value) : refusedReply("force approve", prUrl, r.error);
  } else {
    const r = await mergePr(deps.review, req);
    text = r.ok ? mergeReply(prUrl, r.value) : mergeRefusedReply(prUrl, r.error);
  }
  deps.review.logger.info("thread command done", { command, prUrl });
  await replyInThread(deps, where, text);
}

/** Thread PRs whose repo is still in the repo list, in thread order. */
async function listedPrs(deps: SlackIngestDeps, thread: ThreadReview): Promise<string[]> {
  const listed = new Set((await deps.review.repoList()).map((r) => r.trim().toLowerCase()));
  return thread.prUrls.filter((url) => {
    const ref = parsePrUrl(url);
    return ref.ok && listed.has(`${ref.value.owner}/${ref.value.repo}`.toLowerCase());
  });
}

/** PRs whose live head differs from the head of their latest review (unknown counts as changed). */
async function splitByNewCommits(deps: SlackIngestDeps, urls: readonly string[]) {
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const url of urls) {
    const ref = parsePrUrl(url);
    const latest = await deps.review.records.latestForPr(url);
    const live = ref.ok ? await deps.review.github.getPullRequest(ref.value) : null;
    const same =
      !!live?.ok &&
      !!latest?.headSha &&
      live.value.sha.toLowerCase() === latest.headSha.toLowerCase();
    (same ? unchanged : changed).push(url);
  }
  return { changed, unchanged };
}

async function reReview(
  deps: SlackIngestDeps,
  ctx: IngestContext,
  candidate: CommandCandidate,
  thread: ThreadReview,
  where: Where,
): Promise<void> {
  const { jobs, uow, logger } = deps.review;
  const { event, command } = candidate;
  const cfg = ingestConfig(deps);
  if (command === "updated" && !withinActiveHours(Number(event.ts) * 1000, cfg.activeHours)) {
    await replyInThread(deps, where, REPLY.outsideHours);
    return;
  }
  if (!(await senderAllowed(deps, event.user, "review"))) return;

  const listed = await listedPrs(deps, thread);
  if (listed.length === 0) {
    await replyInThread(deps, where, REPLY.noListedPr);
    return;
  }
  const recent = await jobs.listRecent({ limit: cfg.activeJobScan });
  const busy = recent.some(
    (j) =>
      (j.state === "queued" || j.state === "running") && j.urls.some((u) => listed.includes(u)),
  );
  if (busy) {
    await replyInThread(deps, where, REPLY.inProgress);
    return;
  }

  const { changed, unchanged } = await splitByNewCommits(deps, listed);
  if (command === "updated" && changed.length === 0) {
    await replyInThread(deps, where, REPLY.noNewCommits);
    return;
  }
  const urls = command === "updated" ? changed : listed;
  const statusTs = thread.statusMessageTs ?? thread.threadTs;
  const id = slackJobId(`${ctx.teamId}:${event.channel}:${event.ts}`);
  const created = await jobs.create({
    id,
    source: "slack",
    state: "queued",
    urls,
    progress: initialProgress(urls, () => null),
    slack: {
      channel: thread.channel,
      ts: statusTs,
      threadTs: thread.threadTs,
      user: thread.requesterSlackId,
    },
  });
  if (!created.ok) {
    if (created.error.kind !== "conflict") {
      logger.error("re-review job not created", { jobId: id, error: created.error.kind });
    }
    return;
  }
  const queued = await uow.run(async (tx) => {
    const r = await tx.enqueueReaction(
      acceptedTarget({
        channel: thread.channel,
        ts: statusTs,
        prUrl: urls[0]!,
        round: nextRound(thread),
        reviewId: id,
      }),
    );
    return r.ok ? ok(undefined) : r;
  });
  if (!queued.ok) logger.warn("⏳ not queued", { jobId: id, error: queued.error.kind });

  await wakeConsumer(deps, REVIEW_JOB_WAKE_CHANNEL);
  const sameSha = command === "review" && changed.length === 0;
  await replyInThread(
    deps,
    where,
    reReviewReply({
      count: urls.length,
      sameSha,
      unchanged: command === "updated" ? unchanged : [],
    }),
  );
}
