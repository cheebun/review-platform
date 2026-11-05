import { useQuery } from "@tanstack/react-query";
import type { MergeSummaryView } from "../../../functions/workbench.logic";
import { Alert, Empty, twx } from "../../../ui";
import { Card, CardError, CardLink, CardLoading } from "./card";
import { mergeSummaryQueryOptions } from "./queries";

const Body = twx("div")(() => "flex flex-col gap-3");
const Figure = twx("p")(() => "flex items-baseline gap-2 text-body-md text-secondary-text");
const Big = twx("span")(() => "text-headline-lg tabular-nums text-heading");
const Note = twx("p")(() => "text-body-sm text-secondary-text");
const Footnote = twx("p")(() => "text-label-sm text-muted-text");

/** FR-GITHUB-05: the same notices as /merge, each with a link to /settings. */
const GITHUB_NOTICE: Record<Exclude<MergeSummaryView["github"], "ready">, [string, string]> = {
  not_configured: ["GitHub 未配置", "保存 GitHub token 后才能合并。"],
  needs_reset: ["需要重新设置", "已保存的 GitHub token 无法解密，请重新保存。"],
  no_repos: ["还没有配置仓库", "添加仓库后，评审过的 PR 会出现在这里。"],
};

/** Merge queue summary: how many reviewed PRs await merge. No live GitHub call. */
export function MergeCard({ className }: { className?: string }) {
  const query = useQuery(mergeSummaryQueryOptions());
  return (
    <Card title="待合并" className={className}>
      {query.isPending ? (
        <CardLoading label="正在加载待合并" />
      ) : query.isError ? (
        <CardError
          error={query.error}
          action="待合并概况加载失败"
          onRetry={() => void query.refetch()}
        />
      ) : (
        <MergeSummary view={query.data} />
      )}
    </Card>
  );
}

function MergeSummary({ view }: { view: MergeSummaryView }) {
  if (view.github !== "ready") {
    const [title, body] = GITHUB_NOTICE[view.github];
    return (
      <Alert tone="warning" title={title} action={<CardLink to="/settings">去设置</CardLink>}>
        {body}
      </Alert>
    );
  }
  if (view.awaiting === 0) return <Empty description="没有待合并的 PR。" />;
  return (
    <Body>
      <Figure>
        <Big>{view.capped ? `${view.awaiting}+` : view.awaiting}</Big>
        个 PR 待合并
      </Figure>
      <Note>其中 {view.passing} 个评审通过</Note>
      <CardLink to="/merge">去合并</CardLink>
      <Footnote>按已保存的评审记录统计；合并条件在 Merge 页实时检查。</Footnote>
    </Body>
  );
}
