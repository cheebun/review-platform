import { useQuery } from "@tanstack/react-query";
import { SLACK_SECRET_KINDS } from "../../../../domain/settings/slack-settings";
import { Alert, Button, Skeleton, twx } from "../../../../ui";
import { ChannelPicker } from "./channel-picker";
import { SecretCard } from "./secret-card";
import { SlackFnError } from "./slack-errors";
import { slackSettingsQueryOptions } from "./slack-queries";

const Section = twx("section")(() => "flex flex-col gap-4");
const SectionTitle = twx("h2")(() => "text-headline-md text-heading");

/** /settings, Slack (FR-SLACKCFG-01..04): three secrets and the review channels. */
export function SlackSection() {
  const query = useQuery(slackSettingsQueryOptions());

  return (
    <Section aria-labelledby="settings-slack">
      <SectionTitle id="settings-slack">Slack</SectionTitle>
      {query.isPending ? (
        <Skeleton lines={3} aria-label="正在加载 Slack 设置" />
      ) : query.isError ? (
        <Alert
          tone="danger"
          title="Slack 设置加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              重试
            </Button>
          }
        >
          请稍后重试
          {query.error instanceof SlackFnError ? `（请求 ID：${query.error.body.requestId}）` : ""}
          。
        </Alert>
      ) : (
        <>
          {query.data.availability === "not_configured" ? (
            <Alert tone="info" title="Slack 未配置">
              保存一个 Slack user token 后，摘要、频道选择和 Slack 评审才能使用。
            </Alert>
          ) : null}
          {query.data.availability === "needs_reset" ? (
            <Alert tone="danger" title="需要重新设置">
              有已保存的 Slack 密钥无法解密（服务器密钥可能已更换）。请重新保存标记的项。
            </Alert>
          ) : null}
          {SLACK_SECRET_KINDS.map((kind) => (
            <SecretCard key={kind} kind={kind} secret={query.data.secrets[kind]} />
          ))}
          <ChannelPicker
            key={query.data.channels.map((c) => c.channelId).join(",")}
            view={query.data}
          />
        </>
      )}
    </Section>
  );
}
