import { useId, useRef, useState } from "react";
import { Button, Tag, twx } from "../../ui";
import { TextField } from "../-form-field";
import { TOKEN_RULES_TEXT } from "../-login-token-text";
import {
  anthropicInput,
  placeError,
  type CredentialType,
  type SetupClient,
  type SetupDraft,
} from "./setup-client";

/*
 * The wizard's steps (FR-AUTH-01). Controlled: the values live in the wizard, so 上一步 / 下一步
 * keep them. The check buttons call the setup-only server functions, which store nothing.
 */

const Section = twx("section")(() => "flex flex-col gap-3");
const Hint = twx("p")(() => "text-body-sm text-secondary-text");
const Row = twx("div")(() => "flex flex-wrap items-center gap-3");
const Choice = twx("label")(() => "flex items-center gap-2 text-body-md text-heading");
const RepoList = twx("ul")(
  () => "flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2",
);
const Ok = twx("output")(() => "text-body-sm text-on-success-soft");
const Failed = twx("output")(() => "text-sm text-on-danger-soft");
const RepoError = twx("p")(() => "text-sm text-on-danger-soft");

type Errors = Record<string, string | undefined>;

/** A field's error paragraph id, for aria-describedby. */
const errId = (uid: string, field: string) => `${uid}-${field.replace(".", "-")}-error`;

type CheckState = { ok: boolean; text: string } | null;
const CHECK_FAILED = "检查失败，请稍后重试。";

/** Runs one setup-only check at a time and keeps its outcome as text. */
function useCheck() {
  const [state, setState] = useState<CheckState>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = (work: () => Promise<CheckState>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setState(null);
    work()
      .catch(() => ({ ok: false, text: CHECK_FAILED }))
      .then(setState)
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  return { state, busy, run, reset: () => setState(null) };
}

const failedText = (result: { ok: false; error: Parameters<typeof placeError>[0] }) =>
  placeError(result.error, "")?.text ?? CHECK_FAILED;

function CheckResult({ state }: { state: CheckState }) {
  if (!state) return null;
  return state.ok ? <Ok>{state.text}</Ok> : <Failed>{state.text}</Failed>;
}

export function TokenStep({
  draft,
  errors,
  onChange,
}: {
  draft: Pick<SetupDraft, "token" | "confirm">;
  errors: Errors;
  onChange(patch: Partial<Pick<SetupDraft, "token" | "confirm">>): void;
}) {
  const uid = useId();
  return (
    <Section>
      <Hint>{TOKEN_RULES_TEXT}之后用它登录本系统。</Hint>
      <TextField
        label="登录令牌"
        id={errId(uid, "token")}
        message={errors.token}
        name="token"
        type="password"
        autoComplete="new-password"
        required
        value={draft.token}
        onChange={(e) => onChange({ token: e.target.value })}
      />
      <TextField
        label="再次输入登录令牌"
        id={errId(uid, "confirm")}
        message={errors.confirm}
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        value={draft.confirm}
        onChange={(e) => onChange({ confirm: e.target.value })}
      />
    </Section>
  );
}

export function AnthropicStep({
  value,
  errors,
  onChange,
  client,
}: {
  value: SetupDraft["anthropic"];
  errors: Errors;
  onChange(patch: Partial<SetupDraft["anthropic"]>): void;
  client: Pick<SetupClient, "testAnthropic">;
}) {
  const uid = useId();
  const check = useCheck();
  const change = (patch: Partial<SetupDraft["anthropic"]>) => {
    check.reset();
    onChange(patch);
  };
  const test = () =>
    check.run(async () => {
      const result = await client.testAnthropic(anthropicInput(value));
      if (!result.ok) return { ok: false, text: failedText(result) };
      const { model, latencyMs } = result.value;
      return { ok: true, text: `连接成功（${model}，${latencyMs} ms）` };
    });
  const types: [CredentialType, string][] = [
    ["api_key", "使用 API key"],
    ["auth_token", "使用 auth token"],
  ];
  return (
    <Section>
      <Hint>评审使用 Anthropic。凭据加密保存，之后可在 Settings 中修改。</Hint>
      <Row role="radiogroup" aria-label="凭据类型">
        {types.map(([type, label]) => (
          <Choice key={type}>
            <input
              type="radio"
              name="credentialType"
              checked={value.credentialType === type}
              onChange={() => change({ credentialType: type })}
            />
            {label}
          </Choice>
        ))}
      </Row>
      <TextField
        label={value.credentialType === "api_key" ? "API key" : "Auth token"}
        id={errId(uid, "anthropic.credential")}
        message={errors["anthropic.credential"]}
        name="credential"
        type="password"
        autoComplete="off"
        value={value.credential}
        onChange={(e) => change({ credential: e.target.value })}
      />
      <TextField
        label="Base URL（可选）"
        id={errId(uid, "anthropic.baseUrl")}
        message={errors["anthropic.baseUrl"]}
        name="baseUrl"
        type="url"
        autoComplete="off"
        value={value.baseUrl}
        onChange={(e) => change({ baseUrl: e.target.value })}
      />
      <TextField
        label="模型（可选）"
        id={errId(uid, "anthropic.model")}
        message={errors["anthropic.model"]}
        name="model"
        autoComplete="off"
        value={value.model}
        onChange={(e) => change({ model: e.target.value })}
      />
      <Row>
        <Button variant="secondary" size="sm" loading={check.busy} onClick={test}>
          测试连接
        </Button>
        <CheckResult state={check.state} />
      </Row>
    </Section>
  );
}

type RepoOption = { fullName: string; private: boolean };

export function GithubStep({
  value,
  errors,
  onChange,
  client,
}: {
  value: SetupDraft["github"];
  errors: Errors;
  onChange(patch: Partial<SetupDraft["github"]>): void;
  client: Pick<SetupClient, "listGithubRepos">;
}) {
  const uid = useId();
  const check = useCheck();
  const [options, setOptions] = useState<RepoOption[] | null>(null);
  const load = () =>
    check.run(async () => {
      const result = await client.listGithubRepos(value.token);
      if (!result.ok) return { ok: false, text: failedText(result) };
      setOptions(result.value.repos);
      const more = result.value.truncated ? "，仅列出前一部分" : "";
      return { ok: true, text: `已验证：${result.value.login}${more}` };
    });
  const toggle = (name: string, on: boolean) =>
    onChange({ repos: on ? [...value.repos, name] : value.repos.filter((r) => r !== name) });
  return (
    <Section>
      <Hint>GitHub 令牌用于读取和合并 PR；仓库列表决定可评审的范围。</Hint>
      <TextField
        label="GitHub 令牌"
        id={errId(uid, "github.token")}
        message={errors["github.token"]}
        name="githubToken"
        type="password"
        autoComplete="off"
        value={value.token}
        onChange={(e) => {
          // Another token may see other repos.
          setOptions(null);
          check.reset();
          onChange({ token: e.target.value });
        }}
      />
      <Row>
        <Button
          variant="secondary"
          size="sm"
          loading={check.busy}
          disabled={value.token === ""}
          onClick={load}
        >
          验证并加载仓库
        </Button>
        <CheckResult state={check.state} />
      </Row>
      {options ? (
        <RepoList aria-label="仓库">
          {options.map((repo) => (
            <li key={repo.fullName}>
              <Choice>
                <input
                  type="checkbox"
                  checked={value.repos.includes(repo.fullName)}
                  onChange={(e) => toggle(repo.fullName, e.target.checked)}
                />
                {repo.fullName}
                {repo.private ? <Tag>私有</Tag> : null}
              </Choice>
            </li>
          ))}
        </RepoList>
      ) : value.repos.length > 0 ? (
        <Hint>已选择：{value.repos.join("、")}</Hint>
      ) : null}
      {errors["github.repos"] ? (
        <RepoError id={errId(uid, "github.repos")}>{errors["github.repos"]}</RepoError>
      ) : null}
    </Section>
  );
}

export function SlackStep({
  value,
  errors,
  onChange,
  client,
}: {
  value: SetupDraft["slack"];
  errors: Errors;
  onChange(patch: Partial<SetupDraft["slack"]>): void;
  client: Pick<SetupClient, "testSlack">;
}) {
  const uid = useId();
  const check = useCheck();
  const test = () =>
    check.run(async () => {
      const result = await client.testSlack(value.userToken);
      if (!result.ok) return { ok: false, text: failedText(result) };
      return { ok: true, text: `连接成功：${result.value.teamName}` };
    });
  return (
    <Section>
      <Hint>Slack 用于在频道中触发评审和回复结果。</Hint>
      <TextField
        label="User token"
        id={errId(uid, "slack.userToken")}
        message={errors["slack.userToken"]}
        name="userToken"
        type="password"
        autoComplete="off"
        value={value.userToken}
        onChange={(e) => {
          check.reset();
          onChange({ userToken: e.target.value });
        }}
      />
      <TextField
        label="Signing secret（可选）"
        id={errId(uid, "slack.signingSecret")}
        message={errors["slack.signingSecret"]}
        name="signingSecret"
        type="password"
        autoComplete="off"
        value={value.signingSecret}
        onChange={(e) => onChange({ signingSecret: e.target.value })}
      />
      <Row>
        <Button
          variant="secondary"
          size="sm"
          loading={check.busy}
          disabled={value.userToken === ""}
          onClick={test}
        >
          测试连接
        </Button>
        <CheckResult state={check.state} />
      </Row>
    </Section>
  );
}
