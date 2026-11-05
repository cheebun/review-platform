import type { Octokit } from "@octokit/rest";
import { createHash } from "node:crypto";
import type { GithubAccount } from "./accounts";
import {
  createOctokit,
  createPullRequestComment,
  fetchPullRequest,
  fetchPullRequestMeta,
  mergePullRequest,
  submitPullRequestReview,
} from "./github";
import { parsePrUrl } from "./parse-pr-url";
import {
  DEFAULT_OPEN_PR_OWNER,
  DEFAULT_OPEN_PR_REPO,
  REVIEW_AUTHORS,
  shouldMergeAfterShip,
} from "./repos";
import {
  buildReviewCommentBody,
  decideGithubEvent,
  highestSeverity,
  runAiReview,
  toAiReviewResult,
} from "./review-ai";
import { buildReviewDiff, ReviewDeferredError } from "./review-input";
import type { AiReviewResult, ExecuteResult } from "./types";

export type ShipProgress = {
  pr?: ExecuteResult["pr"] & { sha: string; baseSha: string };
  review?: AiReviewResult;
  /** Legacy partial results are ignored: a fresh review must cover the complete Diff. */
  batchReview?: { fingerprint: string; total: number; results: AiReviewResult[] };
  commentId?: number;
  githubReviewId?: number;
  merged?: boolean;
  completed?: boolean;
};

type ShipOptions = {
  progress?: ShipProgress;
  checkpoint?: (progress: ShipProgress) => Promise<void>;
  requestId?: string;
  restrictToReviewList?: boolean;
  allowAnyAuthor?: boolean;
  octokit?: Octokit;
  review?: typeof runAiReview;
  /** Avoid starting another review near the end of a serverless invocation. */
  startReviewBefore?: number;
};

/** Shared by the UI and Slack worker. Checkpoints let Slack resume completed steps. */
export async function shipPullRequest(
  url: string,
  account: GithubAccount,
  options: ShipOptions = {},
): Promise<ExecuteResult> {
  const ref = parsePrUrl(url);
  if (
    options.restrictToReviewList &&
    (ref.owner.toLowerCase() !== DEFAULT_OPEN_PR_OWNER ||
      ref.repo.toLowerCase() !== DEFAULT_OPEN_PR_REPO)
  ) {
    throw new Error("Slack 自动 Review 仅允许 bosinc/katana-web。");
  }
  const octokit = options.octokit ?? createOctokit(account);
  const progress = options.progress ?? {};
  const save = () => options.checkpoint?.(progress) ?? Promise.resolve();
  const meta = await fetchPullRequestMeta(octokit, ref);
  if (
    options.restrictToReviewList &&
    !options.allowAnyAuthor &&
    !REVIEW_AUTHORS.some((author) => author.toLowerCase() === meta.author.toLowerCase())
  ) {
    throw new Error(`作者 ${meta.author} 不在 PR Review 白名单中。`);
  }
  if (
    progress.pr &&
    (progress.pr.sha !== meta.sha ||
      (!meta.merged && (progress.pr.base !== meta.base || progress.pr.baseSha !== meta.baseSha)))
  ) {
    throw new Error("PR 已更新，旧 Review 不会用于批准新提交。请重新发送 PR 链接。");
  }
  if (meta.draft || (meta.state !== "open" && !meta.merged)) {
    throw new Error("PR 必须是未关闭的非 Draft PR。");
  }
  if (!progress.review) {
    if (meta.merged) throw new Error("PR 已合并，跳过自动 Review。");
    const { data: actor } = await octokit.users.getAuthenticated();
    if (actor.login.toLowerCase() === meta.author.toLowerCase()) {
      throw new Error("不能批准自己的 PR，请在页面使用 Merge。");
    }
    const pr = await fetchPullRequest(octokit, ref);
    if (!pr.complete) {
      throw new Error(`PR Diff 不完整，已停止自动批准。${pr.incompleteReason ?? ""}`);
    }
    if (pr.sha !== meta.sha || pr.baseSha !== meta.baseSha || pr.base !== meta.base) {
      throw new Error("PR 在读取 Diff 时发生更新，请重新 Review。");
    }
    const diffText = buildReviewDiff(pr.diffFiles);
    if (!diffText) throw new Error("PR 没有可审查的 Diff，已停止自动批准。");
    progress.pr = {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: pr.title,
      author: pr.author,
      htmlUrl: pr.htmlUrl,
      base: pr.base,
      head: pr.head,
      sha: pr.sha,
      baseSha: pr.baseSha,
    };
    delete progress.batchReview;
    await save();
    if (options.startReviewBefore != null && Date.now() >= options.startReviewBefore) {
      throw new ReviewDeferredError();
    }
    const result = await (options.review ?? runAiReview)({
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: pr.title,
      body: pr.body,
      author: pr.author,
      base: pr.base,
      head: pr.head,
      diffText,
    });
    progress.review = toAiReviewResult(result);
    await save();
  }
  const pr = progress.pr;
  const review = progress.review;
  if (!pr || !review) throw new Error("Review 检查点不完整。");
  const githubEvent = decideGithubEvent(review.findings);
  const approved = githubEvent === "APPROVE";
  const reviewCommentBody = buildReviewCommentBody(review);

  // Recover a merge whose GitHub response arrived just before a worker restart.
  if (meta.merged && progress.githubReviewId && approved && shouldMergeAfterShip(pr.author)) {
    progress.merged = true;
    await save();
  } else {
    const current = await fetchPullRequestMeta(octokit, ref);
    if (
      current.sha !== pr.sha ||
      current.base !== pr.base ||
      current.baseSha !== pr.baseSha ||
      current.state !== "open" ||
      current.draft
    ) {
      throw new Error("PR 在 AI Review 期间发生变化，已停止后续操作。");
    }
    if (!progress.commentId) {
      const key = options.requestId
        ? createHash("sha256").update(`${options.requestId}:${pr.sha}`).digest("hex")
        : null;
      const marker = key ? `<!-- review:${key} -->` : null;
      if (marker) {
        const comments = await octokit.paginate(octokit.issues.listComments, {
          owner: ref.owner,
          repo: ref.repo,
          issue_number: ref.number,
          per_page: 100,
        });
        progress.commentId = comments.find((comment) => comment.body?.includes(marker))?.id;
      }
      if (!progress.commentId) {
        const comment = await createPullRequestComment(
          octokit,
          ref,
          marker ? `${reviewCommentBody}\n\n${marker}` : reviewCommentBody,
        );
        progress.commentId = comment.id;
      }
      await save();
    }
    if (!progress.githubReviewId) {
      if (options.requestId) {
        const { data: actor } = await octokit.users.getAuthenticated();
        const reviews = await octokit.paginate(octokit.pulls.listReviews, {
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
          per_page: 100,
        });
        const latest = reviews
          .filter((item) => item.user?.login.toLowerCase() === actor.login.toLowerCase())
          .sort((a, b) => b.id - a.id)[0];
        if (
          latest?.commit_id === pr.sha &&
          latest.state === (approved ? "APPROVED" : "CHANGES_REQUESTED")
        ) {
          progress.githubReviewId = latest.id;
        }
      }
      if (!progress.githubReviewId) {
        const submitted = await submitPullRequestReview(
          octokit,
          ref,
          githubEvent,
          undefined,
          pr.sha,
        );
        progress.githubReviewId = submitted.id;
      }
      await save();
    }
    if (approved && shouldMergeAfterShip(pr.author) && !progress.merged) {
      const merged = await mergePullRequest(octokit, ref, pr.sha);
      if (!merged.merged) throw new Error(merged.message || "已批准，但 GitHub 未完成合并。");
      progress.merged = true;
      await save();
    }
  }
  return {
    mode: "ship",
    pr,
    review,
    highestSeverity: highestSeverity(review.findings),
    approved,
    merged: Boolean(progress.merged),
    githubEvent,
    reviewCommentBody,
    githubReviewId: progress.githubReviewId,
  };
}
