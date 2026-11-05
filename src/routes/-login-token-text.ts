import { MIN_LOGIN_TOKEN_LENGTH, validateLoginTokenInput } from "../domain/identity/login-token";
import type { LoginTokenErrorBody } from "../functions/login-token.logic";

/*
 * UI copy for choosing a login token: the /setup step and the rotation form on /settings. The
 * domain messages are English and never shown; these mirror the same rules (FR-AUTH-02).
 */

export const TOKEN_RULES_TEXT = `至少 ${MIN_LOGIN_TOKEN_LENGTH} 个字符，首尾不能有空格。`;
export const EMPTY_TOKEN_TEXT = "请输入登录令牌";
export const EMPTY_CONFIRM_TEXT = "请再次输入登录令牌";
export const MISMATCH_TEXT = "两次输入的登录令牌不一致";
/** The server rejected the token without a rule the client knows: never its own text. */
export const TOKEN_REJECTED_TEXT = "登录令牌不符合要求";

/** The new token's field error, if any. Checked as typed: nothing is trimmed. */
export function newTokenError(token: string): string | undefined {
  if (token === "") return EMPTY_TOKEN_TEXT;
  if (validateLoginTokenInput(token).ok) return undefined;
  if (token.trim().length !== token.length) return "登录令牌首尾不能有空格";
  return `登录令牌至少 ${MIN_LOGIN_TOKEN_LENGTH} 个字符`;
}

/** The confirm field's error, if any. */
export function confirmError(token: string, confirm: string): string | undefined {
  if (confirm === "") return EMPTY_CONFIRM_TEXT;
  return confirm === token ? undefined : MISMATCH_TEXT;
}

/** A 429's retry time, rounded up to whole minutes (as on /login). */
export const lockedOutText = (seconds: number | undefined) =>
  `尝试次数过多，请 ${Math.max(1, Math.ceil((seconds ?? 60) / 60))} 分钟后再试。`;

/** A 400 on the new token or its confirmation, as the field it belongs to. */
export function newTokenServerErrors(
  error: LoginTokenErrorBody,
  token: string,
): Record<string, string> | undefined {
  if (error.kind !== "validation") return undefined;
  if (error.field === "token") return { token: newTokenError(token) ?? TOKEN_REJECTED_TEXT };
  if (error.field === "confirm") return { confirm: MISMATCH_TEXT };
  return undefined;
}
