import type {
  FinishSetupInput,
  SetupGithubRepos,
  SetupSection,
  SetupSections,
} from "../../application/identity/setup";
import type { LlmProbeView } from "../../application/settings/llm-settings";
import type { SetupErrorBody, SetupFnResult } from "../../functions/setup.logic";
import {
  lockedOutText,
  MISMATCH_TEXT,
  newTokenError,
  TOKEN_REJECTED_TEXT,
} from "../-login-token-text";

/*
 * The wizard's model (FR-AUTH-01): every value lives in React state only, never in storage, a
 * cookie or the URL. `finishSetup` is the one write; the other calls are setup-only checks.
 */

/** The setup server functions. Injected so the wizard is testable. */
export interface SetupClient {
  sections(): Promise<SetupFnResult<SetupSections>>;
  testAnthropic(input: AnthropicInput): Promise<SetupFnResult<LlmProbeView>>;
  listGithubRepos(token: string): Promise<SetupFnResult<SetupGithubRepos>>;
  testSlack(userToken: string): Promise<SetupFnResult<{ teamName: string }>>;
  finish(input: FinishSetupInput): Promise<SetupFnResult<null>>;
}

export type { SetupSection, SetupSections };
type AnthropicInput = NonNullable<FinishSetupInput["anthropic"]>;

/** 1 login token, 2 AI (Anthropic), 3 GitHub, 4 Slack. */
export type SetupStep = 1 | 2 | 3 | 4;
export const LAST_STEP: SetupStep = 4;
export const SECTION_STEP: Record<SetupSection, SetupStep> = { anthropic: 2, github: 3, slack: 4 };

export type CredentialType = "api_key" | "auth_token";
export type SetupDraft = {
  token: string;
  confirm: string;
  anthropic: { credentialType: CredentialType; credential: string; baseUrl: string; model: string };
  github: { token: string; repos: string[] };
  slack: { userToken: string; signingSecret: string };
  /** Sections left for later (稍后配置): not sent, so stored values stay. */
  skipped: Record<SetupSection, boolean>;
};

export const EMPTY_DRAFT: SetupDraft = {
  token: "",
  confirm: "",
  anthropic: { credentialType: "api_key", credential: "", baseUrl: "", model: "" },
  github: { token: "", repos: [] },
  slack: { userToken: "", signingSecret: "" },
  skipped: { anthropic: false, github: false, slack: false },
};

/** Only non-empty optional values are sent: an empty one means the default. */
function present<T extends Record<string, string>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "")) as Partial<T>;
}

export function anthropicInput(a: SetupDraft["anthropic"]): AnthropicInput {
  const key = a.credentialType === "api_key" ? "apiKey" : "authToken";
  return present({ [key]: a.credential, baseUrl: a.baseUrl, model: a.model });
}

/** The single `finishSetup` payload. Values are sent verbatim; the server trims where it should. */
export function finishInput(draft: SetupDraft): FinishSetupInput {
  const input: FinishSetupInput = { token: draft.token, confirm: draft.confirm };
  if (!draft.skipped.anthropic) input.anthropic = anthropicInput(draft.anthropic);
  if (!draft.skipped.github) input.github = { ...draft.github };
  if (!draft.skipped.slack) {
    const { userToken, signingSecret } = draft.slack;
    input.slack = signingSecret ? { userToken, signingSecret } : { userToken };
  }
  return input;
}

const SERVICE: Record<SetupSection, string> = {
  anthropic: "Anthropic",
  github: "GitHub",
  slack: "Slack",
};

/** Where an error shows: a field of a step, or the step itself (`field` null). */
export type PlacedError = { step: SetupStep; field: string | null; text: string };

const INVALID_TEXT: Record<string, string> = {
  "anthropic.credential": "请填写有效的 API key 或 auth token（二选一）",
  "anthropic.baseUrl": "Base URL 无效，或端点拒绝了请求",
  "anthropic.model": "模型名称无效",
  "github.token": "GitHub 令牌格式不正确",
  "github.repos": "仓库选择无效",
  "slack.userToken": "请填写以 xoxp- 开头的 Slack user token",
  "slack.signingSecret": "Signing secret 应为 16–128 位十六进制字符",
};

const REJECTED_TEXT: Record<string, string> = {
  "anthropic.credential": "Anthropic 拒绝了该凭据",
  "github.token": "GitHub 拒绝了该令牌",
  "github.repos": "令牌无法访问所选的仓库",
  "slack.userToken": "Slack 拒绝了该令牌",
};

const isSection = (s: string): s is SetupSection => s in SECTION_STEP;

/** The Anthropic credential has one input, whichever field the server named. */
const displayField = (field: string) =>
  field === "anthropic.apiKey" || field === "anthropic.authToken" ? "anthropic.credential" : field;

/**
 * Places a server error on the step and field it belongs to, in Chinese. The server's own text is
 * never shown. Null: no field, so the caller shows a generic message where it is.
 */
export function placeError(error: SetupErrorBody, token: string): PlacedError | null {
  if (error.field === "token") {
    return { step: 1, field: "token", text: newTokenError(token) ?? TOKEN_REJECTED_TEXT };
  }
  if (error.field === "confirm") return { step: 1, field: "confirm", text: MISMATCH_TEXT };
  const field = error.field ? displayField(error.field) : "";
  const section = field.split(".")[0] ?? "";
  if (!isSection(section)) return null;
  const step = SECTION_STEP[section];
  if (error.kind === "rate_limited") {
    return { step, field: null, text: lockedOutText(error.retryAfterSeconds) };
  }
  if (error.kind === "validation" && INVALID_TEXT[field]) {
    return { step, field, text: INVALID_TEXT[field] };
  }
  if (error.kind === "forbidden" && REJECTED_TEXT[field]) {
    return { step, field, text: REJECTED_TEXT[field] };
  }
  return { step, field: null, text: `${SERVICE[section]} 暂时无法访问，请稍后重试。` };
}
