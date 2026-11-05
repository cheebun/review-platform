import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Alert, Button, FormError, Tag, twx } from "../../ui";
import { confirmError, newTokenError } from "../-login-token-text";
import {
  EMPTY_DRAFT,
  finishInput,
  LAST_STEP,
  placeError,
  type SetupClient,
  type SetupDraft,
  type SetupSection,
  type SetupStep,
} from "./setup-client";
import { AnthropicStep, GithubStep, SlackStep, TokenStep } from "./setup-steps";

const Page = twx("main")(() => "mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6");
const Card = twx("div")(
  () => "flex flex-col gap-6 rounded-lg border border-border bg-surface p-6 shadow-sm",
);
const Title = twx("h1")(() => "text-headline-lg text-heading");
const Steps = twx("ol")(() => "flex flex-wrap items-center gap-2 text-label-md");
const stepClass = (current: boolean, done: boolean) =>
  [
    "rounded-md px-2 py-1",
    current ? "bg-primary-soft text-primary-ink" : done ? "text-heading" : "text-secondary-text",
  ].join(" ");
const StepHead = twx("div")(() => "flex flex-wrap items-center gap-2");
const StepTitle = twx("h2")(() => "text-headline-md text-heading");
const Hint = twx("p")(() => "text-body-sm text-secondary-text");
const Footer = twx("div")(
  () => "flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4",
);

const STEP_LABELS: Record<SetupStep, string> = { 1: "登录令牌", 2: "AI", 3: "GitHub", 4: "Slack" };
const STEP_TITLES: Record<SetupStep, string> = {
  1: "设置登录令牌",
  2: "AI",
  3: "GitHub",
  4: "Slack",
};
const STEP_SECTION: Record<Exclude<SetupStep, 1>, SetupSection> = {
  2: "anthropic",
  3: "github",
  4: "slack",
};
const FINISH_ERROR = "完成设置失败，请稍后重试。";

type Errors = Record<string, string | undefined>;

/** Client-side checks for 下一步 / 完成; the server checks everything again. */
function stepErrors(step: SetupStep, draft: SetupDraft, configured: boolean): Errors {
  switch (step) {
    case 1:
      return {
        token: newTokenError(draft.token),
        confirm: confirmError(draft.token, draft.confirm),
      };
    case 2:
      // Already configured: an empty credential keeps the stored one.
      return {
        "anthropic.credential":
          draft.anthropic.credential === "" && !configured
            ? "请填写 API key 或 auth token"
            : undefined,
      };
    case 3:
      return { "github.token": draft.github.token === "" ? "请输入 GitHub 令牌" : undefined };
    case 4:
      return {
        "slack.userToken": draft.slack.userToken === "" ? "请输入 Slack user token" : undefined,
      };
  }
}

const hasErrors = (errors: Errors) => Object.values(errors).some(Boolean);

export interface SetupWizardProps {
  client: SetupClient;
  /** `finishSetup` succeeded: the owner is signed in. */
  onDone(): void;
  /** Someone else finished setup first. */
  toLogin(): void;
}

/**
 * The first-run wizard (FR-AUTH-01): the login token, then AI, GitHub and Slack (each optional,
 * with 稍后配置). Every value stays in this component's state until 完成 sends them all in one
 * `finishSetup` call; nothing is stored in the browser or the URL, so a reload starts over.
 * Outside the app shell.
 */
export function SetupWizard({ client, onDone, toLogin }: SetupWizardProps) {
  const [step, setStep] = useState<SetupStep>(1);
  const [draft, setDraft] = useState<SetupDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Errors>({});
  const [stepError, setStepError] = useState<{ step: SetupStep; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous guard: two clicks in one tick both see `busy` false.
  const pending = useRef(false);

  // Unknown (loading, failed) counts as not configured.
  const sections = useQuery({
    queryKey: ["setup", "sections"],
    queryFn: async () => {
      const result = await client.sections();
      if (!result.ok) throw new Error(result.error.kind);
      return result.value;
    },
    staleTime: Infinity,
  });
  const section = step === 1 ? null : STEP_SECTION[step];
  const configured = section !== null && sections.data?.[section] === true;

  const go = (next: SetupStep) => {
    setStepError(null);
    setStep(next);
  };

  const update = <K extends "anthropic" | "github" | "slack">(
    key: K,
    patch: Partial<SetupDraft[K]>,
    fields: string[],
  ) => {
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
    setErrors((e) => ({ ...e, ...Object.fromEntries(fields.map((f) => [f, undefined])) }));
  };

  async function submit(final: SetupDraft) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStepError(null);
    try {
      const result = await client.finish(finishInput(final));
      if (result.ok) return onDone();
      if (result.error.kind === "conflict") return setConflict(true);
      const placed = placeError(result.error, final.token);
      if (placed) {
        setStep(placed.step);
        if (placed.field) setErrors({ [placed.field]: placed.text });
        else setStepError({ step: placed.step, text: placed.text });
        return;
      }
    } catch {
      // Falls through to the generic message.
    } finally {
      pending.current = false;
      setBusy(false);
    }
    setStepError({ step, text: FINISH_ERROR });
  }

  const next = () => {
    const found = stepErrors(step, draft, configured);
    if (hasErrors(found)) return setErrors((e) => ({ ...e, ...found }));
    const final = section ? { ...draft, skipped: { ...draft.skipped, [section]: false } } : draft;
    setDraft(final);
    if (step === LAST_STEP) return void submit(final);
    go((step + 1) as SetupStep);
  };

  const later = () => {
    if (!section) return;
    const final = { ...draft, skipped: { ...draft.skipped, [section]: true } };
    setDraft(final);
    if (step === LAST_STEP) return void submit(final);
    go((step + 1) as SetupStep);
  };

  if (conflict) {
    return (
      <Page>
        <Card>
          <Alert
            tone="warning"
            title="系统已初始化"
            action={
              <Button variant="secondary" size="sm" onClick={toLogin}>
                前往登录
              </Button>
            }
          >
            设置已由他人完成，请使用已设置的登录令牌登录。
          </Alert>
        </Card>
      </Page>
    );
  }

  const last = step === LAST_STEP;
  return (
    <Page>
      <Card>
        <Title>设置 Review platform</Title>
        <Steps aria-label="设置步骤">
          {([1, 2, 3, 4] as const).map((n) => (
            <li
              key={n}
              className={stepClass(n === step, n < step)}
              aria-current={n === step ? "step" : undefined}
            >
              {STEP_LABELS[n]}
            </li>
          ))}
        </Steps>
        <Hint>
          所有内容仅保存在本页面中，点击“完成”后才一次性提交；刷新页面会清空已填写的内容，需从第 1
          步重新开始。
        </Hint>
        <StepHead>
          <StepTitle>{STEP_TITLES[step]}</StepTitle>
          {section ? configured ? <Tag tone="success">已配置</Tag> : <Tag>可选</Tag> : null}
        </StepHead>
        {configured ? <Hint>已有配置。稍后配置会保留现有配置；填写并继续则替换它。</Hint> : null}
        {step === 1 ? (
          <TokenStep
            draft={draft}
            errors={errors}
            onChange={(patch) => {
              setDraft((d) => ({ ...d, ...patch }));
              setErrors((e) => ({
                ...e,
                ...Object.fromEntries(Object.keys(patch).map((k) => [k, undefined])),
              }));
            }}
          />
        ) : step === 2 ? (
          <AnthropicStep
            value={draft.anthropic}
            errors={errors}
            client={client}
            onChange={(patch) =>
              update(
                "anthropic",
                patch,
                Object.keys(patch).map(
                  (k) => `anthropic.${k === "credentialType" ? "credential" : k}`,
                ),
              )
            }
          />
        ) : step === 3 ? (
          <GithubStep
            value={draft.github}
            errors={errors}
            client={client}
            onChange={(patch) =>
              update(
                "github",
                patch,
                Object.keys(patch).map((k) => `github.${k}`),
              )
            }
          />
        ) : (
          <SlackStep
            value={draft.slack}
            errors={errors}
            client={client}
            onChange={(patch) =>
              update(
                "slack",
                patch,
                Object.keys(patch).map((k) => `slack.${k}`),
              )
            }
          />
        )}
        <Footer>
          {stepError?.step === step ? <FormError>{stepError.text}</FormError> : null}
          {step > 1 ? (
            <Button variant="ghost" disabled={busy} onClick={() => go((step - 1) as SetupStep)}>
              上一步
            </Button>
          ) : null}
          {section ? (
            <Button variant="secondary" loading={busy && last} disabled={busy} onClick={later}>
              {last ? "稍后配置并完成" : "稍后配置"}
            </Button>
          ) : null}
          <Button loading={busy && last} disabled={busy} onClick={next}>
            {last ? "完成" : "下一步"}
          </Button>
        </Footer>
      </Card>
    </Page>
  );
}
