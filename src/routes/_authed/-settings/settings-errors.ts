import type { SettingsErrorBody } from "../../../functions/settings.logic";

/** A settings server function failure, as the forms see it. */
export class SettingsFnError extends Error {
  constructor(readonly body: SettingsErrorBody) {
    super(body.kind);
    this.name = "SettingsFnError";
  }
}

export const TOKEN_FORMAT_TEXT = "Token 应为 20–255 个可见字符，不含空格。";
export const TOKEN_REJECTED_TEXT = "GitHub 拒绝了这个 token，请检查它是否有效、是否已过期。";
export const REPO_FORMAT_TEXT = "格式应为 owner/repo。";
export const REPO_DUPLICATE_TEXT = "这个仓库已在列表中。";
export const REPO_INVALID_TEXT = "无法添加：仓库名无效、已在列表中，或已达上限。";
export const repoNoAccessText = (repo: string) => `当前 token 无法访问 ${repo}。`;

/** Fixed Chinese text by kind; the server message is never shown (S4). */
const BY_KIND: Partial<Record<SettingsErrorBody["kind"], string>> = {
  unauthenticated: "登录已过期，请重新登录。",
  forbidden: "没有权限执行这个操作。",
  rate_limited: "尝试次数过多，请稍后再试。",
  upstream: "无法连接 GitHub，请稍后重试。未保存任何更改。",
  not_configured: "请先保存一个可用的 GitHub token。",
  not_found: "这个仓库已不在列表中。",
};

/** "保存失败：<reason>（请求 ID：r-1）", or just the action when the cause is unknown. */
export function settingsErrorText(error: unknown, action: string): string {
  if (!(error instanceof SettingsFnError)) return `${action}，请稍后重试。`;
  const reason = BY_KIND[error.body.kind];
  return `${reason ? `${action}：${reason}` : action}（请求 ID：${error.body.requestId}）`;
}
