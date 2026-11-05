import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { LlmSettingsView } from "../../../../application/settings/llm-settings";
import type { LlmCredentialView } from "../../../../domain/settings/llm-settings";
import { removeLlmSectionFn } from "../../../../functions/settings-llm";
import { Alert, Button, Dialog, Skeleton, Tag, Text, notify, twx } from "../../../../ui";
import { AnthropicForm } from "./anthropic-form";
import { LlmFnError, llmErrorText } from "./llm-errors";
import { callLlmFn, llmSettingsKeys, llmSettingsQueryOptions } from "./llm-queries";

const Section = twx("section")(() => "flex flex-col gap-4");
const SectionTitle = twx("h2")(() => "text-headline-md text-heading");
const Connection = twx("section")(
  () => "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4",
);
const Head = twx("div")(() => "flex flex-wrap items-center gap-2");
const Meta = twx("div")(() => "flex flex-wrap items-center gap-2 text-body-sm text-secondary-text");

const savedAtText = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

function CredentialStatus({ credential }: { credential: LlmCredentialView }) {
  if (credential.state === "unset") return <Tag>未设置</Tag>;
  if (credential.state === "needs_reset") return <Tag tone="danger">需要重新设置</Tag>;
  return credential.verifiedAt ? (
    <Tag tone="success">✓ 已验证</Tag>
  ) : (
    <Tag tone="warning">⚠ 未验证</Tag>
  );
}

/** Connection status and removal stay mounted when a save resets the form. */
function AnthropicSettings({ view }: { view: LlmSettingsView }) {
  const uid = useId();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const { credential } = view.anthropic;
  const remove = useMutation({
    mutationFn: () => callLlmFn(removeLlmSectionFn({ data: { section: "anthropic" } })),
    onSuccess: (next) => {
      queryClient.setQueryData(llmSettingsKeys.view(), next);
      setConfirming(false);
      notify.success("Anthropic 设置已移除");
    },
    onError: (error) => notify.error(llmErrorText(error, "移除失败")),
  });

  return (
    <Connection aria-labelledby={`${uid}-title`}>
      <Head>
        <Text weight="medium" id={`${uid}-title`}>
          Anthropic
        </Text>
        <CredentialStatus credential={credential} />
        {view.availability === "ready" ? <Tag tone="info">使用中</Tag> : null}
      </Head>
      {credential.state !== "unset" ? (
        <Meta>
          <span>…{credential.last4}</span>
          {credential.model ? <span>测试模型 {credential.model}</span> : null}
          {credential.latencyMs !== undefined ? <span>{credential.latencyMs} ms</span> : null}
          <span>保存于 {savedAtText(credential.savedAt)}</span>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            移除
          </Button>
        </Meta>
      ) : null}
      <AnthropicForm key={JSON.stringify(view.anthropic)} section={view.anthropic} />
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="移除 Anthropic 设置？"
        description="移除后将停用 LLM 功能，直到重新配置 Anthropic。"
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
    </Connection>
  );
}

/** Anthropic settings with write-only credentials. */
export function LlmSection() {
  const query = useQuery(llmSettingsQueryOptions());

  return (
    <Section aria-labelledby="settings-llm">
      <SectionTitle id="settings-llm">LLM</SectionTitle>
      {query.isPending ? (
        <Skeleton lines={3} aria-label="正在加载 LLM 设置" />
      ) : query.isError ? (
        <Alert
          tone="danger"
          title="LLM 设置加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              重试
            </Button>
          }
        >
          请稍后重试
          {query.error instanceof LlmFnError ? `（请求 ID：${query.error.body.requestId}）` : ""}。
        </Alert>
      ) : (
        <>
          {query.data.availability === "not_configured" ? (
            <Alert tone="info" title="LLM 未配置">
              配置 Anthropic 后即可使用代码审查和 Slack 摘要。
            </Alert>
          ) : null}
          {query.data.availability === "needs_reset" ? (
            <Alert tone="danger" title="需要重新设置">
              已保存的 LLM 设置无法使用（密钥无法解密或设置无效）。请重新保存标记的项。
            </Alert>
          ) : null}
          <AnthropicSettings view={query.data} />
        </>
      )}
    </Section>
  );
}
