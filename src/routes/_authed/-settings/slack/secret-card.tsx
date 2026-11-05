import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import type { SlackSettingsView } from "../../../../application/settings/slack-settings";
import {
  parseSlackSecret,
  type SlackSecretKind,
  type SlackSecretView,
} from "../../../../domain/settings/slack-settings";
import { removeSlackSecretFn, saveSlackSecretFn } from "../../../../functions/settings-slack";
import { Button, Dialog, Form, FormError, Tag, Text, notify, twx } from "../../../../ui";
import { firstError, serverError, setServerErrors, TextField } from "../../../-form-field";
import {
  SECRET_FORMAT_TEXT,
  SECRET_REJECTED_TEXT,
  SlackFnError,
  slackErrorText,
  USER_TOKEN_BOT_TEXT,
} from "./slack-errors";
import { callSlackFn, slackSettingsKeys } from "./slack-queries";

const Card = twx("section")(
  () => "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4",
);
const Head = twx("div")(() => "flex flex-wrap items-center gap-2");
const Meta = twx("div")(() => "flex flex-wrap items-center gap-2 text-body-sm text-secondary-text");
const Hint = twx("p")(() => "text-body-sm text-secondary-text");
const Row = twx("div")(() => "flex flex-wrap items-end gap-3");
const Grow = twx("div")(() => "flex min-w-0 flex-1 flex-col gap-1 sm:max-w-md");

type SecretCopy = { label: string; hint: string; removeEffect: string };

const COPY: Record<SlackSecretKind, SecretCopy> = {
  slack_user_token: {
    label: "User token",
    hint: "xoxp- 开头。保存时用 auth.test 验证，必须属于用户而非 bot。",
    removeEffect: "移除后 Slack 摘要、频道选择和 Slack 评审将不可用。频道选择会保留。",
  },
  slack_signing_secret: {
    label: "Signing secret",
    hint: "只检查格式；收到第一个签名事件后才标记为已验证。",
    removeEffect: "移除后将无法校验 Slack 事件请求。",
  },
};

const savedAtText = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

function StatusTags({ secret }: { secret: SlackSecretView }) {
  if (secret.state === "unset") return <Tag>未设置</Tag>;
  if (secret.state === "needs_reset") return <Tag tone="danger">需要重新设置</Tag>;
  return secret.verifiedAt ? (
    <Tag tone="success">✓ 已验证</Tag>
  ) : (
    <Tag tone="warning">⚠ 未验证</Tag>
  );
}

function fieldText(kind: SlackSecretKind, error: SlackFnError, submitted: string): string {
  if (error.body.kind === "forbidden") return SECRET_REJECTED_TEXT;
  // The client already checked the format; a user token the server still refuses is a bot's.
  if (kind === "slack_user_token" && parseSlackSecret(kind, submitted).ok) {
    return USER_TOKEN_BOT_TEXT;
  }
  return SECRET_FORMAT_TEXT[kind];
}

/** One Slack secret: status and last 4, a write-only input, and remove. Never shows a value. */
export function SecretCard({ kind, secret }: { kind: SlackSecretKind; secret: SlackSecretView }) {
  const uid = useId();
  const copy = COPY[kind];
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const setView = (next: SlackSettingsView) => {
    queryClient.setQueryData(slackSettingsKeys.view(), next);
    void queryClient.invalidateQueries({ queryKey: slackSettingsKeys.channels() });
  };

  const form = useForm({
    defaultValues: { value: "" },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        if (value.value.trim() === "") return { fields: { value: "请输入一个值。" } };
        return parseSlackSecret(kind, value.value).ok
          ? undefined
          : { fields: { value: SECRET_FORMAT_TEXT[kind] } };
      },
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        setView(await callSlackFn(saveSlackSecretFn({ data: { kind, value: value.value } })));
        formApi.reset();
        notify.success(`${copy.label} 已保存`);
      } catch (error) {
        if (error instanceof SlackFnError && error.body.field && error.body.field !== "channels") {
          setServerErrors(formApi, { fields: { value: fieldText(kind, error, value.value) } });
        } else {
          setServerErrors(formApi, { form: slackErrorText(error, "保存失败") });
        }
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => callSlackFn(removeSlackSecretFn({ data: { kind } })),
    onSuccess: (next) => {
      setView(next);
      setConfirming(false);
      notify.success(`${copy.label} 已移除`);
    },
    onError: (error) => notify.error(slackErrorText(error, "移除失败")),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void form.handleSubmit();
  };

  const stored = secret.state !== "unset";
  return (
    <Card aria-labelledby={`${uid}-title`}>
      <Head>
        <Text weight="medium" id={`${uid}-title`}>
          {copy.label}
        </Text>
        <StatusTags secret={secret} />
      </Head>
      {secret.state !== "unset" ? (
        <Meta>
          <span>…{secret.last4}</span>
          {secret.teamName ? <span>工作区 {secret.teamName}</span> : null}
          {secret.userName ? <span>用户 {secret.userName}</span> : null}
          <span>保存于 {savedAtText(secret.savedAt)}</span>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            移除
          </Button>
        </Meta>
      ) : null}
      <Hint>{copy.hint}</Hint>

      <Form onSubmit={submit} noValidate aria-label={`${copy.label} 表单`}>
        <Row>
          <Grow>
            <form.Field name="value">
              {(field) => (
                <TextField
                  label={copy.label}
                  id={`${uid}-value`}
                  message={firstError(field.state.meta.errors)}
                  name={`${kind}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              )}
            </form.Field>
          </Grow>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" loading={isSubmitting}>
                {stored ? "替换" : "保存"}
              </Button>
            )}
          </form.Subscribe>
        </Row>
        <form.Subscribe selector={(state) => serverError(state.errorMap.onServer)}>
          {(failure) => (failure ? <FormError>{failure}</FormError> : null)}
        </form.Subscribe>
      </Form>

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`移除 ${copy.label}？`}
        description={copy.removeEffect}
        dismissible={!remove.isPending}
        closeLabel="关闭"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={remove.isPending}
            >
              取消
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              确认移除
            </Button>
          </>
        }
      />
    </Card>
  );
}
