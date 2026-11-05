import type {
  ApprovalView,
  RequesterView,
  TimelineItem,
  VerdictMarker,
} from "../../../functions/review.logic";

/** The Slack markers (FR-REVIEW-06). A failed review has none. */
export function markerText(marker: VerdictMarker): string | null {
  switch (marker) {
    case "pass":
      return "🟢 通过";
    case "changes_requested":
      return "🔴 需修改";
    case "force_approved":
      return "🟡 强制批准";
    default:
      return null;
  }
}

export const MERGED_TEXT = "✅ 已合并";

/** The auto-approve skip reasons (`AutoApproveSkipReason`), in words. */
const SKIP_REASON: Record<string, string> = {
  not_passed: "评审未通过",
  repo_not_allowed: "仓库不在列表中",
  pr_merged: "PR 已合并",
  pr_closed: "PR 已关闭",
  pr_draft: "PR 是草稿",
  own_pr: "自己的 PR",
  sha_changed: "PR 有新提交",
  already_approved: "已批准过",
};

export const reasonText = (reason: string) => SKIP_REASON[reason] ?? reason;

export function approvalText(approval: ApprovalView | null): string {
  if (!approval) return "未批准";
  switch (approval.kind) {
    case "approved":
      return approval.source === "system" ? "已批准（auto: review passed）" : "已批准";
    case "force_approved":
      return "🟡 强制批准";
    case "skipped":
      return approval.reason ? `已跳过：${reasonText(approval.reason)}` : "已跳过";
    case "failed":
      return approval.reason ? `批准失败：${reasonText(approval.reason)}` : "批准失败";
  }
}

export function requesterText(r: RequesterView): string {
  if (r.self) return "你";
  switch (r.kind) {
    case "slack":
      return `Slack ${r.id}`;
    case "machine":
      return "machine";
    case "user":
      return `用户 ${r.id}`;
  }
}

const UTC8_MS = 8 * 3600_000;

/** `YYYY-MM-DD HH:mm` in UTC+8, the app's working timezone; independent of the browser's. */
export function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + UTC8_MS).toISOString().slice(0, 16).replace("T", " ");
}

const SEVERITY: Record<string, string> = {
  P0: "P0 阻塞",
  P1: "P1 高优",
  P2: "P2 中等",
  Nit: "Nit 微调",
};

export const severityLabel = (s: string) => SEVERITY[s] ?? s;

const EVENT: Record<TimelineItem["type"], string> = {
  review_started: "开始评审",
  review_finished: "评审完成",
  review_failed: "评审失败",
  comment_posted: "已发表评论",
  changes_requested: "要求修改",
  approved: "已批准",
  approve_skipped: "跳过批准",
  approve_failed: "批准失败",
  force_approved: "🟡 强制批准",
  merged: MERGED_TEXT,
  merge_failed: "合并失败",
};

export const eventLabel = (type: TimelineItem["type"]) => EVENT[type] ?? type;
