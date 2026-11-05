import type { LlmSettingsErrorBody } from "../../../../functions/settings-llm.logic";

/** An LLM settings server function failure, as the forms see it. */
export class LlmFnError extends Error {
  constructor(readonly body: LlmSettingsErrorBody) {
    super(body.kind);
    this.name = "LlmFnError";
  }
}

/** Fixed client texts; the server's field message (English, fixed) is never shown. */
export const LLM_FIELD_TEXT = {
  baseUrl: "Base URL 必须是 http 或 https 地址，不含用户名密码、查询参数或片段。",
  model: "模型名只能包含字母、数字和 . _ : / @ + -，最多 200 个字符。",
  secret: "密钥为 16–1024 个可见字符，不含空格。",
  credential: "请填写 API key 或 auth token（只能二选一）。",
} as const;
export const CREDENTIAL_REJECTED_TEXT = "LLM 服务拒绝了这个凭据，请检查它是否有效、是否已被撤销。";
export const ENDPOINT_REFUSED_TEXT = "端点拒绝了测试请求，请检查 Base URL 和模型。";

const BY_KIND: Partial<Record<LlmSettingsErrorBody["kind"], string>> = {
  unauthenticated: "登录已过期，请重新登录。",
  forbidden: "没有权限执行这个操作。",
  rate_limited: "尝试次数过多，请稍后再试。",
  upstream: "无法连接 LLM 端点，测试请求失败。未保存任何更改。",
  not_configured: "LLM 未配置。",
  validation: "输入无效。",
};

/** "保存失败：<reason>（请求 ID：r-1）", or just the action when the cause is unknown. */
export function llmErrorText(error: unknown, action: string): string {
  if (!(error instanceof LlmFnError)) return `${action}，请稍后重试。`;
  const reason = BY_KIND[error.body.kind];
  return `${reason ? `${action}：${reason}` : action}（请求 ID：${error.body.requestId}）`;
}
