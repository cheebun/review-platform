import type { GateStatusView, MergeHistoryItem, RefusalCode } from "../../../functions/merge.logic";
import type { MergeGateId } from "../../../domain/ship/policy";

export { formatTime, MERGED_TEXT } from "../-review/format";

const GATE: Record<MergeGateId, string> = {
  allowlist: "仓库在列表中",
  open: "PR 未关闭",
  not_draft: "不是草稿",
  approved_at_sha: "已在当前 SHA 批准",
  no_p0: "没有 P0 问题",
  checks_green: "CI 检查通过",
  mergeable: "GitHub 可合并",
};

export const gateLabel = (id: MergeGateId) => GATE[id] ?? id;

const STATUS: Record<GateStatusView, string> = {
  pass: "通过",
  fail: "未通过",
  waived: "已豁免（强制批准）",
  unknown: "未知",
};

export const gateStatusText = (s: GateStatusView) => STATUS[s];

export const gateStatusIcon = (s: GateStatusView) =>
  s === "pass" ? "✅" : s === "waived" ? "🟡" : s === "unknown" ? "❔" : "❌";

const REASON: Record<RefusalCode, string> = {
  ownerOnly: "只有负责人可以合并。",
  repoNotAllowed: "仓库不在列表中。",
  merged: "PR 已合并。",
  closed: "PR 已关闭。",
  draft: "PR 是草稿。",
  noReview: "PR 还没有评审。",
  staleReview: "评审不是针对当前 SHA，请重新评审。",
  changesRequested: "评审要求修改。",
  notApproved: "请先 approve（或 force approve）。",
  staleApproval: "批准不是针对当前 SHA，请重新 approve。",
  staleForceApproval: "强制批准不是针对当前 SHA，请重新 force approve。",
  p0: "存在 P0 问题，需要 force approve。",
  checksNotGreen: "CI 检查未全部通过。",
  notMergeable: "GitHub 报告无法合并（可能有冲突）。",
  mergeableUnknown: "GitHub 还在计算是否可合并，请稍后刷新。",
  headMoved: "PR 有新提交，已刷新检查项，请重新确认。",
  githubRejected: "GitHub 拒绝了合并。",
  checksUnavailable: "无法读取 CI 检查状态，请稍后刷新。",
  unavailable: "暂时无法读取 GitHub，请稍后刷新。",
};

export const reasonText = (code: RefusalCode) => REASON[code] ?? "无法合并。";

export function mergedByText(actor: MergeHistoryItem["actor"]): string {
  if (actor.self) return "你";
  switch (actor.kind) {
    case "user":
      return `用户 ${actor.id}`;
    case "machine":
      return "machine";
    default:
      return actor.id;
  }
}

export function sourceText(source: MergeHistoryItem["source"]): string {
  switch (source) {
    case "web":
      return "Web";
    case "slack":
      return "Slack";
    case "system":
      return "系统";
    default:
      return "—";
  }
}
