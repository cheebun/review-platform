import type { SlackSecretKind } from "../../../../domain/settings/slack-settings";
import type { SlackSettingsErrorBody } from "../../../../functions/settings-slack.logic";

/** A Slack settings server function failure, as the forms see it. */
export class SlackFnError extends Error {
  constructor(readonly body: SlackSettingsErrorBody) {
    super(body.kind);
    this.name = "SlackFnError";
  }
}

/** Fixed client texts; the server's field message (English, fixed) is never shown. */
export const SECRET_FORMAT_TEXT: Record<SlackSecretKind, string> = {
  slack_user_token: "User token 以 xoxp- 开头，至少 24 个可见字符，不含空格。",
  slack_signing_secret: "Signing secret 是 16–128 位十六进制字符。",
};
export const SECRET_REJECTED_TEXT = "Slack 拒绝了这个值，请检查它是否有效、是否已被撤销。";
export const USER_TOKEN_BOT_TEXT = "这是 bot token。请使用 user token（xoxp-）。";
export const CHANNELS_INVALID_TEXT = "只能选择你已加入的频道，且最多 200 个。";

const BY_KIND: Partial<Record<SlackSettingsErrorBody["kind"], string>> = {
  unauthenticated: "登录已过期，请重新登录。",
  forbidden: "没有权限执行这个操作。",
  rate_limited: "尝试次数过多，请稍后再试。",
  upstream: "无法连接 Slack，请稍后重试。未保存任何更改。",
  not_configured: "请先保存一个可用的 Slack user token。",
  validation: "输入无效。",
};

/** "保存失败：<reason>（请求 ID：r-1）", or just the action when the cause is unknown. */
export function slackErrorText(error: unknown, action: string): string {
  if (!(error instanceof SlackFnError)) return `${action}，请稍后重试。`;
  const reason =
    error.body.kind === "not_configured" && error.body.reason === "needs_reset"
      ? "已保存的 user token 无法解密，请重新保存。"
      : BY_KIND[error.body.kind];
  return `${reason ? `${action}：${reason}` : action}（请求 ID：${error.body.requestId}）`;
}
