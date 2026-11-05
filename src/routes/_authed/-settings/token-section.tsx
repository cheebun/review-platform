import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import type { SettingsView } from "../../../application/settings/view";
import { parseTokenInput } from "../../../domain/settings/github-credential";
import { removeGithubTokenFn, saveGithubTokenFn } from "../../../functions/settings";
import { settingsKeys } from "../../../queries/settings";
import { Alert, Button, Dialog, Form, FormError, Tag, Text, notify, twx } from "../../../ui";
import { firstError, serverError, setServerErrors, TextField } from "../../-form-field";
import {
  SettingsFnError,
  settingsErrorText,
  TOKEN_FORMAT_TEXT,
  TOKEN_REJECTED_TEXT,
} from "./settings-errors";

const Card = twx("section")(
  () => "flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface p-4",
);
const Avatar = twx("img")(() => "size-10 rounded-full border border-border");
const Who = twx("div")(() => "flex min-w-0 flex-1 flex-col gap-1");
const Meta = twx("div")(() => "flex flex-wrap items-center gap-2 text-body-sm text-secondary-text");
const Row = twx("div")(() => "flex flex-wrap items-end gap-3");
const Grow = twx("div")(() => "flex min-w-0 flex-1 flex-col gap-1 sm:max-w-md");

const savedAtText = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

/** Client-side check; the server repeats it. */
function tokenError(value: string): string | undefined {
  if (value.trim() === "") return "请输入 token。";
  return parseTokenInput(value).ok ? undefined : TOKEN_FORMAT_TEXT;
}

async function call<T>(
  promise: Promise<{ ok: true; value: T } | { ok: false; error: SettingsFnError["body"] }>,
): Promise<T> {
  const result = await promise;
  if (result.ok) return result.value;
  throw new SettingsFnError(result.error);
}

export function TokenSection({ view }: { view: SettingsView }) {
  const uid = useId();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const setView = (next: SettingsView) => queryClient.setQueryData(settingsKeys.view(), next);

  const form = useForm({
    defaultValues: { token: "" },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const token = tokenError(value.token);
        return token ? { fields: { token } } : undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        setView(await call(saveGithubTokenFn({ data: { token: value.token } })));
        formApi.reset();
        notify.success("Token 已保存");
      } catch (error) {
        const body = error instanceof SettingsFnError ? error.body : undefined;
        if (body?.field === "token") {
          const token = body.kind === "forbidden" ? TOKEN_REJECTED_TEXT : TOKEN_FORMAT_TEXT;
          setServerErrors(formApi, { fields: { token } });
        } else {
          setServerErrors(formApi, { form: settingsErrorText(error, "保存失败") });
        }
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => call(removeGithubTokenFn()),
    onSuccess: (next) => {
      setView(next);
      setConfirming(false);
      notify.success("Token 已移除");
    },
    onError: (error) => notify.error(settingsErrorText(error, "移除失败")),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void form.handleSubmit();
  };

  const token = view.token;
  return (
    <>
      {view.availability === "not_configured" ? (
        <Alert tone="info" title="GitHub 未配置">
          保存一个 GitHub token 后，Review、Merge 和 Slack 评审才能使用。推荐 fine-grained
          token，仓库权限：Contents 与 Pull requests 读写，Checks 与 Commit statuses 只读。
        </Alert>
      ) : null}
      {view.availability === "needs_reset" ? (
        <Alert tone="danger" title="需要重新设置">
          已保存的 token 无法解密（服务器密钥可能已更换）。请重新保存一个 token。
        </Alert>
      ) : null}

      {token ? (
        <Card aria-label="GitHub 连接">
          <Avatar src={token.avatarUrl} alt="" width={40} height={40} />
          <Who>
            <Text weight="medium">{token.login}</Text>
            <Meta>
              <span>Token …{token.last4}</span>
              <Tag>{token.tokenKind === "classic" ? "Classic" : "Fine-grained"}</Tag>
              {view.availability === "ready" ? (
                <Tag tone="success">就绪</Tag>
              ) : (
                <Tag tone="danger">需要重新设置</Tag>
              )}
              <span>保存于 {savedAtText(token.savedAt)}</span>
            </Meta>
          </Who>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            移除 token
          </Button>
        </Card>
      ) : null}

      <Form onSubmit={submit} noValidate aria-label="GitHub token 表单">
        <Row>
          <Grow>
            <form.Field name="token">
              {(field) => (
                <TextField
                  label="GitHub token"
                  id={`${uid}-token`}
                  message={firstError(field.state.meta.errors)}
                  name={field.name}
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
                {token ? "替换 token" : "保存 token"}
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
        title="移除 GitHub token？"
        description="移除后 Review、Merge 和 Slack 评审将不可用。仓库列表会保留。"
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
    </>
  );
}

export { call as callSettingsFn };
