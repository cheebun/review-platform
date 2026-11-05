import type { GithubAccount } from "./accounts";
import { shipPullRequest, type ShipProgress } from "./ship-pr";
import { ReviewDeferredError } from "./review-input";
import type { SlackReviewJob } from "./slack-review-store";

function buildSlackResultReply(job: SlackReviewJob) {
  const p0Links = job.urls.flatMap((url) => {
    const progress = job.progress[url];
    if (
      !progress?.review?.findings.some((finding) => finding.severity === "P0") ||
      !progress.pr?.htmlUrl ||
      progress.commentId == null
    )
      return [];
    return [`<${progress.pr.htmlUrl}#issuecomment-${progress.commentId}|see comment>`];
  });
  if (p0Links.length) return p0Links.join("\n");

  const findings = job.urls.flatMap((url) => job.progress[url]?.review?.findings ?? []);
  if (findings.length === 0) return "approved";

  const hasMinorIssues = job.urls.some((url) =>
    job.progress[url]?.review?.findings.some(
      (finding) => finding.severity === "P1" || finding.severity === "P2",
    ),
  );
  return hasMinorIssues ? "approved with minor issues" : null;
}

function formatSlackFailure(error: string) {
  if (error === "PR 已合并，跳过自动 Review。") return "PR 已合并，无法继续处理。";
  if (error === "不能批准自己的 PR，请在页面使用 Merge。") {
    return "这是当前账号创建的 PR，请在页面完成 Merge。";
  }
  if (error === "Slack 自动 Review 仅允许 bosinc/katana-web。") return "PR 地址不在支持范围内。";
  if (error === "PR 必须是未关闭的非 Draft PR。") return "PR 当前不是可处理状态。";
  if (error.includes("PR 已更新") || error.includes("PR 在 AI Review 期间发生变化")) {
    return "PR 在处理期间发生变化，请重新发送最新链接。";
  }
  if (error.includes("PR Diff 不完整") || error.includes("PR 在读取 Diff 时发生更新")) {
    return "PR 变更内容不完整，无法继续处理。";
  }
  if (error === "PR 没有可审查的 Diff，已停止自动批准。") return "PR 没有可处理的变更。";
  return "暂时无法完成处理，请稍后重试。";
}

export type RunnerDependencies = {
  senderIds?: readonly string[];
  reply?: (channel: string, ts: string, threadTs?: string, text?: string) => Promise<void>;
  startReviewBefore?: number;
  ship: (
    url: string,
    account: GithubAccount,
    options: {
      progress: ShipProgress;
      checkpoint: (progress: ShipProgress) => Promise<void>;
      requestId: string;
      restrictToReviewList: boolean;
      allowAnyAuthor: boolean;
      startReviewBefore?: number;
    },
  ) => Promise<unknown>;
  react: (channel: string, ts: string) => Promise<void>;
};

/** One message can contain several PRs. React only after every Ship completes. */
export async function runSlackReviewJob(
  store: { save(): Promise<void> },
  job: SlackReviewJob,
  dependencies: RunnerDependencies,
) {
  const touch = () => {
    job.updatedAt = new Date().toISOString();
  };
  const sendTerminalReply = async (text: string) => {
    if (job.resultReplySent) return;
    if (dependencies.reply) {
      await dependencies.reply(job.channel, job.ts, job.threadTs, text);
    }
    job.resultReplySent = true;
    touch();
    await store.save();
  };
  const fail = async (error: string) => {
    job.status = "failed";
    job.error = error;
    job.nextAttemptAt = undefined;
    try {
      await sendTerminalReply(`review failed: ${formatSlackFailure(error)}`);
    } catch (replyError) {
      job.error = `${error}（Slack 失败回复发送失败：${replyError instanceof Error ? replyError.message : "未知错误"}）`;
    }
    touch();
    await store.save();
  };
  try {
    if (job.status !== "reaction_pending") {
      job.status = "running";
      touch();
      await store.save();
      for (const url of job.urls) {
        const progress = job.progress[url] ?? (job.progress[url] = {});
        if (progress.completed) continue;
        let reviewed = Boolean(progress.review);
        await dependencies.ship(url, job.account, {
          progress,
          requestId: `${job.id}:${url}`,
          restrictToReviewList: true,
          allowAnyAuthor: true,
          startReviewBefore: dependencies.startReviewBefore,
          checkpoint: async (next) => {
            job.progress[url] = next;
            if (next.review && !reviewed) {
              // A completed review is progress, even if a later GitHub step is interrupted.
              job.interruptions = 0;
              reviewed = true;
            }
            touch();
            await store.save();
          },
        });
        progress.completed = true;
        touch();
        await store.save();
      }
      job.status = "reaction_pending";
      touch();
      await store.save();
    }
    const resultReply = buildSlackResultReply(job);
    if (resultReply) await sendTerminalReply(resultReply);
    await dependencies.react(job.channel, job.ts);
    job.status = "done";
    job.error = undefined;
    job.nextAttemptAt = undefined;
  } catch (error) {
    if (error instanceof ReviewDeferredError) {
      job.status = "queued";
      job.error = undefined;
      job.nextAttemptAt = undefined;
    } else if (job.status === "reaction_pending") {
      job.error = error instanceof Error ? error.message : "Slack 回执失败";
      // Retrying a reaction never re-runs AI or GitHub writes.
      job.nextAttemptAt = Date.now() + 30_000;
    } else {
      await fail(error instanceof Error ? error.message : "Slack Review 执行失败");
      return;
    }
  }
  touch();
  await store.save();
}

export const defaultSlackShip = shipPullRequest;
