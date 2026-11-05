/**
 * The thread replies of the Slack commands, in Chinese (S4: generic, never a raw error).
 * Pure. Status words use Slack shortcodes so Slack renders them.
 */
import type { DomainError } from "../../domain/shared/result";
import { REFUSAL, type MergeGate, type MergeGateId } from "../../domain/ship/policy";
import type { ApproveOutcome, ForceApproveOutcome, MergeOutcome } from "../ship/ship";

export const REPLY = {
  onIt: "on it",
  noNewCommits: "上次审核后没有新提交",
  inProgress: "正在审核中",
  outsideHours: "审核只在 09:00–19:00（UTC+8）进行，请在这个时间段内再回复 updated。",
  noListedPr: "这个线程里没有仓库列表中的 PR。",
  rateLimited: "请求太频繁，请稍后再试。",
  failed: "操作失败，请稍后再试。",
} as const;

const short = (sha: string) => sha.slice(0, 7);

/** Policy refusal reasons (`REFUSAL`) and ship refusals, keyed by their English text. */
const REASON_ZH: Record<string, string> = {
  [REFUSAL.invalidInput]: "无法读取 PR 状态。",
  [REFUSAL.ownerOnly]: "只有 owner 可以执行这个操作。",
  [REFUSAL.systemOnly]: "只有审核流程可以自动 approve。",
  [REFUSAL.repoNotAllowed]: "仓库不在仓库列表中。",
  [REFUSAL.merged]: "PR 已经合并。",
  [REFUSAL.closed]: "PR 已关闭。",
  [REFUSAL.draft]: "PR 还是草稿。",
  [REFUSAL.ownPr]: "不能 approve 自己的 PR。",
  [REFUSAL.noReview]: "这个 PR 还没有审核记录，请先回复 review。",
  [REFUSAL.staleReview]: "审核后有新提交，需要重新审核（回复 review 或 updated）。",
  [REFUSAL.changesRequested]: "最新审核要求修改；如需覆盖，请回复 force approve。",
  [REFUSAL.notApproved]: "请先 approve（或 force approve）",
  [REFUSAL.staleApproval]: "approve 后有新提交，需要重新审核。",
  [REFUSAL.staleForceApproval]: "force approve 后有新提交，需要重新审核。",
  [REFUSAL.p0]: "最新审核有 P0 问题。",
  [REFUSAL.checksNotGreen]: "必需的检查还没有通过。",
  [REFUSAL.notMergeable]: "GitHub 显示这个 PR 当前不可合并。",
  "GitHub has not finished checking whether the PR can be merged; try again shortly.":
    "GitHub 还在计算是否可以合并，请稍后再试。",
  "The PR head moved since it was shown; refresh and check again.": "PR 有新提交，请重新检查。",
};

/** A user-facing reason for any error; unknown texts fall back to a generic line. */
export function reasonText(error: DomainError): string {
  switch (error.kind) {
    case "forbidden":
      return REASON_ZH[error.reason] ?? "没有权限执行这个操作。";
    case "conflict":
      return REASON_ZH[error.reason] ?? "PR 状态已变化，请稍后再试。";
    case "validation":
      return REASON_ZH[error.message] ?? "PR 链接无效。";
    case "not_found":
      return "找不到这个 PR。";
    case "rate_limited":
      return "GitHub 限流，请稍后再试。";
    case "upstream":
      return error.service === "github" ? "GitHub 暂时不可用，请稍后再试。" : REPLY.failed;
    case "not_configured":
      return error.feature === "github" ? "GitHub 未配置。" : "功能未配置。";
    case "unauthenticated":
      return "GitHub 凭据无效。";
    case "deferred":
      return "已在后台继续处理。";
  }
}

const GATE_LABEL: Record<MergeGateId, string> = {
  allowlist: "仓库在列表中",
  open: "PR 未关闭",
  not_draft: "非草稿",
  approved_at_sha: "当前提交已 approve",
  no_p0: "无 P0",
  checks_green: "检查已通过",
  mergeable: "可合并",
};

const GATE_MARK = { pass: ":white_check_mark:", fail: ":x:", waived: ":warning:" } as const;

export function gateChecklist(gates: readonly MergeGate[]): string {
  return gates
    .map((g) => {
      const label = g.id === "no_p0" && g.status === "waived" ? "P0 已豁免" : GATE_LABEL[g.id];
      return `${GATE_MARK[g.status]} ${label}`;
    })
    .join("\n");
}

export function approveReply(prUrl: string, out: ApproveOutcome): string {
  return out.status === "approved"
    ? `已 approve ${prUrl}（${short(out.sha)}）`
    : `${prUrl} 在当前提交（${short(out.sha)}）已经 approve 过了`;
}

export function forceApproveReply(prUrl: string, out: ForceApproveOutcome): string {
  switch (out.status) {
    case "force_approved":
      return `已 force approve ${prUrl}（${short(out.sha)}），仅对这个提交有效`;
    case "already_force_approved":
      return `${prUrl} 在当前提交（${short(out.sha)}）已经 force approve 过了`;
    case "already_approved_by_review":
      return `${prUrl} 的最新审核已通过并已 approve（${short(out.sha)}），无需 force approve`;
  }
}

export function mergeReply(prUrl: string, out: MergeOutcome): string {
  return out.status === "merged"
    ? `已合并 ${prUrl}（${short(out.sha)}，合并提交 ${short(out.mergeSha)}）`
    : `${prUrl} 已经合并`;
}

export function mergeRefusedReply(
  prUrl: string,
  failure: { error: DomainError; gates: readonly MergeGate[] },
): string {
  const head = `无法合并 ${prUrl}：${reasonText(failure.error)}`;
  return failure.gates.length > 0 ? `${head}\n${gateChecklist(failure.gates)}` : head;
}

export function refusedReply(action: string, prUrl: string, error: DomainError): string {
  return `${action} ${prUrl} 未执行：${reasonText(error)}`;
}

export function whichPrReply(prUrls: readonly string[]): string {
  return [
    "这个线程有多个 PR，Slack 里无法确定要操作哪一个。请在网页上操作：",
    ...prUrls.map((u) => `• ${u}`),
  ].join("\n");
}

export function reReviewReply(opts: { count: number; sameSha: boolean; unchanged: string[] }) {
  const lines = [
    opts.sameSha
      ? `收到，在同一提交上重新审核 ${opts.count} 个 PR`
      : `收到，开始重新审核 ${opts.count} 个 PR`,
  ];
  for (const url of opts.unchanged) lines.push(`${url}：${REPLY.noNewCommits}`);
  return lines.join("\n");
}
