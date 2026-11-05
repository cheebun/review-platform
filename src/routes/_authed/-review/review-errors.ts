import { FnRequestError } from "../../../queries/fn-result";

/** Fixed Chinese text by kind; the server message is never shown (S4). */
const BY_KIND: Partial<Record<FnRequestError["kind"], string>> = {
  unauthenticated: "登录已过期，请重新登录。",
  validation: "筛选条件无效，请检查日期范围。",
  not_found: "找不到这条评审。",
};

/** "<action>：<reason>（请求 ID：r-1）", or just the action when the cause is unknown. */
export function reviewErrorText(error: unknown, action: string): string {
  if (!(error instanceof FnRequestError)) return `${action}，请稍后重试。`;
  const reason = BY_KIND[error.kind];
  return `${reason ? `${action}：${reason}` : `${action}，请稍后重试`}（请求 ID：${error.requestId}）`;
}
