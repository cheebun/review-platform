import { FnRequestError } from "../../../queries/fn-result";

/** Fixed Chinese text by kind; the server message is never shown (S4). */
const BY_KIND: Partial<Record<FnRequestError["kind"], string>> = {
  unauthenticated: "登录已过期，请重新登录。",
  forbidden: "没有权限执行此操作。",
  not_found: "找不到这个 PR，或仓库不在列表中。",
  rate_limited: "操作太频繁，请稍后再试。",
  not_configured: "GitHub 未配置。",
  conflict: "状态已变化，请刷新后重试。",
  upstream: "GitHub 暂时不可用。",
};

/** "<action>：<reason>（请求 ID：r-1）", or just the action when the cause is unknown. */
export function mergeErrorText(error: unknown, action: string): string {
  if (!(error instanceof FnRequestError)) return `${action}，请稍后重试。`;
  const reason = BY_KIND[error.kind];
  return `${reason ? `${action}：${reason}` : `${action}，请稍后重试`}（请求 ID：${error.requestId}）`;
}
