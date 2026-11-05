import { FnRequestError } from "../../../queries/fn-result";

/** Fixed Chinese text by kind; the server message is never shown (S4). */
const BY_KIND: Partial<Record<FnRequestError["kind"], string>> = {
  unauthenticated: "登录已过期，请重新登录。",
  forbidden: "没有权限查看。",
  rate_limited: "请求太频繁，请稍后再试。",
  upstream: "服务暂时不可用，请稍后重试。",
  not_configured: "服务未配置。",
};

/** "<action>：<reason>（请求 ID：r-1）", or "<action>，请稍后重试。" when the cause is unknown. */
export function workbenchErrorText(error: unknown, action: string): string {
  if (!(error instanceof FnRequestError)) return `${action}，请稍后重试。`;
  const reason = BY_KIND[error.kind];
  return `${reason ? `${action}：${reason}` : `${action}，请稍后重试`}（请求 ID：${error.requestId}）`;
}
