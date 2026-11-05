import { useQuery } from "@tanstack/react-query";
import type { SetupState, SetupStatusView } from "../../../functions/workbench.logic";
import { Tag, twx } from "../../../ui";
import { Card, CardError, CardLink, CardLoading } from "./card";
import { setupStatusQueryOptions } from "./queries";

const Rows = twx("ul")(() => "flex flex-col divide-y divide-border");
const Row = twx("li")(() => "flex items-center gap-3 py-2");
const Name = twx("span")(() => "min-w-16 text-body-md text-heading");
const Action = twx("span")(() => "ml-auto");

/** In /settings order (docs/requirements.md §2.7). */
const SECTIONS: { key: keyof SetupStatusView; label: string }[] = [
  { key: "github", label: "GitHub" },
  { key: "slack", label: "Slack" },
  { key: "llm", label: "LLM" },
];

const STATE: Record<SetupState, { text: string; tone: "success" | "neutral" | "warning" }> = {
  configured: { text: "已配置", tone: "success" },
  not_configured: { text: "未配置", tone: "neutral" },
  needs_reset: { text: "需要重新设置", tone: "warning" },
};

/** Which /settings sections are configured. States only: the server never sends a value. */
export function SetupCard({ className }: { className?: string }) {
  const query = useQuery(setupStatusQueryOptions());
  return (
    <Card title="设置状态" className={className}>
      {query.isPending ? (
        <CardLoading label="正在加载设置状态" lines={3} />
      ) : query.isError ? (
        <CardError
          error={query.error}
          action="设置状态加载失败"
          onRetry={() => void query.refetch()}
        />
      ) : (
        <Rows aria-label="配置项">
          {SECTIONS.map(({ key, label }) => {
            const state = STATE[query.data[key]];
            return (
              <Row key={key}>
                <Name>{label}</Name>
                <Tag tone={state.tone}>{state.text}</Tag>
                {query.data[key] === "configured" ? null : (
                  <Action>
                    <CardLink to="/settings" aria-label={`去设置 ${label}`}>
                      去设置
                    </CardLink>
                  </Action>
                )}
              </Row>
            );
          })}
        </Rows>
      )}
    </Card>
  );
}
