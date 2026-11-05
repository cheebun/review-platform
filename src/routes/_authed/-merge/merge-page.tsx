import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import { useState } from "react";
import { mergePrFn } from "../../../functions/merge";
import type {
  GateView,
  MergeGatesView,
  MergeOutcomeView,
  MergeQueueItem,
  MergeQueueView,
} from "../../../functions/merge.logic";
import { unwrapFnResult } from "../../../queries/fn-result";
import {
  Alert,
  Button,
  Code,
  Dialog,
  Empty,
  RefreshIcon,
  Skeleton,
  Spinner,
  Tag,
  notify,
  twx,
} from "../../../ui";
import {
  formatTime,
  gateLabel,
  gateStatusIcon,
  gateStatusText,
  mergedByText,
  reasonText,
  sourceText,
} from "./format";
import { mergeErrorText } from "./merge-errors";
import {
  HISTORY_MAX,
  HISTORY_PAGE,
  mergeGatesQueryOptions,
  mergeHistoryQueryOptions,
  mergeKeys,
  mergeQueueQueryOptions,
} from "./queries";

const Page = twx("div")(() => "flex flex-col gap-8");
const Section = twx("section")(() => "flex flex-col gap-3");
const Intro = twx("div")(() => "flex flex-col gap-1");
const Kicker = twx("p")(() => "text-label-sm uppercase tracking-wide text-muted-text");
const Title = twx("h1")(() => "text-headline-lg text-heading");
const SectionTitle = twx("h2")(() => "text-headline-sm text-heading");
const Description = twx("p")(() => "max-w-3xl text-body-md text-secondary-text");
const Rows = twx("ul")(
  () => "flex flex-col divide-y divide-border rounded-lg border border-border bg-surface",
);
const Row = twx("li")(() => "flex flex-col gap-3 px-card-padding-x py-4");
const RowHead = twx("div")(() => "flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4");
const RowMain = twx("div")(() => "flex min-w-0 flex-1 flex-col gap-1");
const RowLine = twx("div")(() => "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1");
const RowMeta = twx("div")(
  () => "flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-secondary-text",
);
const PrTitle = twx("span")(() => "min-w-0 break-words text-body-md text-heading");
const Gates = twx("ul")(() => "grid grid-cols-1 gap-x-6 gap-y-1 text-body-sm sm:grid-cols-2");
const Gate = twx("li")(() => "flex items-center gap-2");
const GateStatus = twx("span")(() => "text-secondary-text");
const Blocked = twx("p")(() => "text-body-sm text-on-warning-soft");
const Checks = twx("p")(() => "break-words text-body-sm text-secondary-text");
const Loading = twx("span").attrs({ role: "status" })(
  () => "inline-flex items-center gap-2 text-body-sm text-secondary-text",
);
const Actions = twx("div")(() => "flex shrink-0 items-center gap-2");
const Time = twx("time")(() => "tabular-nums");
const More = twx("div")(() => "flex justify-center");
const TableWrap = twx("div")(() => "overflow-x-auto rounded-lg border border-border bg-surface");
const Table = twx("table")(() => "w-full min-w-[40rem] text-left text-body-sm");
const Th = twx("th")(() => "px-4 py-2 text-label-sm font-medium text-secondary-text");
const Td = twx("td")(() => "border-t border-border px-4 py-2 align-top");
const ShaLine = twx("p")(() => "break-all");
const InternalAnchor = twx("a")(
  () =>
    "font-mono text-label-md text-primary-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
);
const RouterLink = createLink(InternalAnchor);
const ExternalAnchor = twx("a").attrs({ target: "_blank", rel: "noopener noreferrer" })(
  () =>
    "font-mono text-label-md text-primary-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
);
const Refresh = twx(RefreshIcon).attrs({ "aria-hidden": true })(() => "size-4");

/** Links only to GitHub PR pages; anything else is shown as text. */
const isGithubPrUrl = (url: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url);

/** /merge (FR-SHIP-05): reviewed PRs awaiting merge, their live gates, and the merge history. */
export function MergePage() {
  return (
    <Page>
      <Intro>
        <Kicker>Github</Kicker>
        <Title>Merge</Title>
        <Description>
          已评审、未合并的 PR。只有全部合并条件通过时才能合并；条件来自 GitHub 的实时状态。
        </Description>
      </Intro>
      <QueueSection />
      <HistorySection />
    </Page>
  );
}

// ---- Queue ----

const GITHUB_ALERT: Record<Exclude<MergeQueueView["github"], "ready">, [string, string]> = {
  not_configured: ["GitHub 未配置", "请先在设置中保存 GitHub token。"],
  needs_reset: ["GitHub 凭据需要重新设置", "已保存的 token 无法解密，请在设置中重新保存。"],
  no_repos: ["还没有配置仓库", "请先在设置中添加允许合并的仓库。"],
};

function QueueSection() {
  const query = useQuery(mergeQueueQueryOptions());
  return (
    <Section aria-labelledby="merge-queue-title">
      <SectionTitle id="merge-queue-title">待合并</SectionTitle>
      {query.isPending ? (
        <Skeleton lines={4} aria-label="正在加载待合并列表" />
      ) : query.isError ? (
        <Alert
          tone="danger"
          title="待合并列表加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              <Refresh />
              重试
            </Button>
          }
        >
          {mergeErrorText(query.error, "无法读取待合并列表")}
        </Alert>
      ) : query.data.github !== "ready" ? (
        <Alert
          tone="warning"
          title={GITHUB_ALERT[query.data.github][0]}
          action={<RouterLink to="/settings">前往设置</RouterLink>}
        >
          {GITHUB_ALERT[query.data.github][1]}
        </Alert>
      ) : query.data.items.length === 0 ? (
        <Empty description="Nothing awaiting merge" />
      ) : (
        <Rows aria-label="待合并" aria-busy={query.isFetching || undefined}>
          {query.data.items.map((item) => (
            <QueueRow key={item.prUrl} item={item} />
          ))}
        </Rows>
      )}
    </Section>
  );
}

type Refusal = Extract<MergeOutcomeView, { status: "refused" }>;

function QueueRow({ item }: { item: MergeQueueItem }) {
  const client = useQueryClient();
  const gates = useQuery(mergeGatesQueryOptions(item.prUrl));
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const label = `${item.repo}#${item.number}`;

  const merge = useMutation({
    mutationFn: async (expectedSha: string) =>
      unwrapFnResult(await mergePrFn({ data: { prUrl: item.prUrl, expectedSha } })),
    onSuccess: (outcome) => {
      setConfirming(false);
      if (outcome.status === "refused") {
        setRefusal(outcome);
        // The PR changed under us (or GitHub said no): show its live gates again.
        void client.invalidateQueries({ queryKey: mergeKeys.gates(item.prUrl) });
        return;
      }
      setRefusal(null);
      notify.success(outcome.status === "merged" ? `已合并 ${label}` : `${label} 已经合并`);
      void client.invalidateQueries({ queryKey: mergeKeys.all });
    },
    onError: (error) => {
      setConfirming(false);
      notify.error(mergeErrorText(error, "合并失败"));
    },
  });

  const live = gates.data;
  const canMerge = !!live && live.state === "open" && live.canMerge && !gates.isFetching;

  return (
    <Row>
      <RowHead>
        <RowMain>
          <RowLine>
            {isGithubPrUrl(item.prUrl) ? (
              <ExternalAnchor href={item.prUrl}>{label}</ExternalAnchor>
            ) : (
              <span>{label}</span>
            )}
            {item.title !== null ? <PrTitle>{item.title}</PrTitle> : null}
          </RowLine>
          <RowMeta>
            {item.author !== null ? <span>{item.author}</span> : null}
            {item.shortSha ? <Code>{item.shortSha}</Code> : null}
            {item.forceApproved ? <Tag tone="warning">🟡 强制批准</Tag> : null}
            <RouterLink to="/review/$reviewId" params={{ reviewId: item.reviewId }}>
              评审记录
            </RouterLink>
            <Time dateTime={item.reviewedAt}>{formatTime(item.reviewedAt)}</Time>
          </RowMeta>
        </RowMain>
        <Actions>
          <Button
            variant="danger"
            size="sm"
            disabled={!canMerge}
            onClick={() => setConfirming(true)}
          >
            Merge
          </Button>
        </Actions>
      </RowHead>

      {gates.isPending ? (
        <Loading aria-label="正在检查合并条件">
          <Spinner />
          正在检查合并条件…
        </Loading>
      ) : gates.isError ? (
        <Alert
          tone="danger"
          title="合并条件读取失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void gates.refetch()}>
              <Refresh />
              重试
            </Button>
          }
        >
          {mergeErrorText(gates.error, "无法读取合并条件")}
        </Alert>
      ) : (
        <GateDetails gates={gates.data} />
      )}

      {refusal ? (
        <Alert tone="danger" title={reasonText(refusal.reason)}>
          <span>{`（请求 ID：${refusal.requestId}）`}</span>
          {refusal.gates.length > 0 ? (
            <GateList gates={refusal.gates} label="拒绝时的合并条件" />
          ) : null}
        </Alert>
      ) : null}

      {live ? (
        <Dialog
          open={confirming}
          onOpenChange={(open) => setConfirming(open)}
          dismissible={!merge.isPending}
          closeLabel="关闭"
          title={`合并 ${label}？`}
          description="将以下 head SHA 合并到目标分支。如果 PR 在此期间有新提交，合并会被拒绝。"
          footer={
            <>
              <Button
                variant="secondary"
                disabled={merge.isPending}
                onClick={() => setConfirming(false)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                loading={merge.isPending}
                onClick={() => merge.mutate(live.headSha)}
              >
                确认合并
              </Button>
            </>
          }
        >
          {item.title !== null ? <p>{item.title}</p> : null}
          <ShaLine>
            head SHA：<Code>{live.headSha}</Code>
          </ShaLine>
          {live.p0Waived ? <p>P0 已通过强制批准豁免。</p> : null}
        </Dialog>
      ) : null}
    </Row>
  );
}

function GateDetails({ gates }: { gates: MergeGatesView }) {
  const checks = gates.checks;
  return (
    <>
      <GateList gates={gates.gates} label="合并条件" />
      {checks && checks.failing.length > 0 ? (
        <Checks>{`失败的检查：${checks.failing.join("、")}`}</Checks>
      ) : null}
      {checks && checks.pending.length > 0 ? (
        <Checks>{`进行中的检查：${checks.pending.join("、")}`}</Checks>
      ) : null}
      {gates.blockedReason ? <Blocked>{reasonText(gates.blockedReason)}</Blocked> : null}
    </>
  );
}

function GateList({ gates, label }: { gates: readonly GateView[]; label: string }) {
  return (
    <Gates aria-label={label}>
      {gates.map((g) => (
        <Gate key={g.id}>
          <span aria-hidden>{gateStatusIcon(g.status)}</span>
          <span>{gateLabel(g.id)}</span>
          <GateStatus>{gateStatusText(g.status)}</GateStatus>
        </Gate>
      ))}
    </Gates>
  );
}

// ---- History ----

function HistorySection() {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const query = useQuery({
    ...mergeHistoryQueryOptions(limit),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items ?? [];
  return (
    <Section aria-labelledby="merge-history-title">
      <SectionTitle id="merge-history-title">合并记录</SectionTitle>
      {query.isPending ? (
        <Skeleton lines={4} aria-label="正在加载合并记录" />
      ) : query.isError && items.length === 0 ? (
        <Alert
          tone="danger"
          title="合并记录加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              <Refresh />
              重试
            </Button>
          }
        >
          {mergeErrorText(query.error, "无法读取合并记录")}
        </Alert>
      ) : items.length === 0 ? (
        <Empty description="No merges yet" />
      ) : (
        <>
          <TableWrap>
            <Table aria-label="合并记录" aria-busy={query.isFetching || undefined}>
              <thead>
                <tr>
                  <Th scope="col">PR</Th>
                  <Th scope="col">合并人</Th>
                  <Th scope="col">来源</Th>
                  <Th scope="col">SHA</Th>
                  <Th scope="col">时间</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const label =
                    e.repo !== null && e.number !== null ? `${e.repo}#${e.number}` : e.prUrl;
                  return (
                    <tr key={e.id}>
                      <Td>
                        {isGithubPrUrl(e.prUrl) ? (
                          <ExternalAnchor href={e.prUrl}>{label}</ExternalAnchor>
                        ) : (
                          <span>{label}</span>
                        )}
                      </Td>
                      <Td>{mergedByText(e.actor)}</Td>
                      <Td>{sourceText(e.source)}</Td>
                      <Td>{e.sha ? <Code title={e.sha}>{e.sha.slice(0, 7)}</Code> : "—"}</Td>
                      <Td>
                        <Time dateTime={e.at}>{formatTime(e.at)}</Time>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
          {query.isError ? (
            <Alert tone="danger" title="加载更多失败">
              {mergeErrorText(query.error, "无法读取更多合并记录")}
            </Alert>
          ) : null}
          {query.data?.hasMore && limit < HISTORY_MAX ? (
            <More>
              <Button
                variant="secondary"
                loading={query.isFetching}
                onClick={() => setLimit((n) => Math.min(n + HISTORY_PAGE, HISTORY_MAX))}
              >
                加载更多
              </Button>
            </More>
          ) : null}
        </>
      )}
    </Section>
  );
}
