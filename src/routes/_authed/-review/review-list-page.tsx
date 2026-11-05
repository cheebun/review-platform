import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import type { ReviewListItem } from "../../../functions/review.logic";
import {
  Alert,
  Button,
  Code,
  Empty,
  Input,
  Label,
  RefreshIcon,
  Select,
  Skeleton,
  Tag,
  twx,
  type SelectItem,
} from "../../../ui";
import { approvalText, formatTime, markerText, MERGED_TEXT, requesterText } from "./format";
import { reviewListQueryOptions } from "./queries";
import { reviewErrorText } from "./review-errors";
import { hasFilters, type ReviewSearch } from "./search";

const Page = twx("div")(() => "flex flex-col gap-6");
const Intro = twx("div")(() => "flex flex-col gap-1");
const Kicker = twx("p")(() => "text-label-sm uppercase tracking-wide text-muted-text");
const Title = twx("h1")(() => "text-headline-lg text-heading");
const Description = twx("p")(() => "max-w-3xl text-body-md text-secondary-text");
const Filters = twx("div").attrs({ role: "group", "aria-label": "筛选" })(
  () =>
    "grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]",
);
const Field = twx("div")(() => "flex min-w-0 flex-col gap-1 text-sm text-secondary-text");
const FieldLabel = twx("span")(() => "text-label-sm");
const Rows = twx("ul")(
  () => "flex flex-col divide-y divide-border rounded-lg border border-border bg-surface",
);
const Row = twx("li")(
  () => "flex flex-col gap-2 px-card-padding-x py-3 sm:flex-row sm:items-center sm:gap-4",
);
const RowMain = twx("div")(() => "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1");
const RowMeta = twx("div")(
  () => "flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-secondary-text",
);
const Marker = twx("span")(() => "text-body-sm text-heading");
const Counts = twx("span")(() => "text-label-sm text-secondary-text");
const Time = twx("time")(() => "tabular-nums");
const More = twx("div")(() => "flex justify-center");
const PrAnchor = twx("a")(
  () =>
    "font-mono text-label-md text-primary-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
);
const PrLink = createLink(PrAnchor);
const Refresh = twx(RefreshIcon).attrs({ "aria-hidden": true })(() => "size-4");

const ALL = "all";
const OUTCOME_ITEMS: SelectItem[] = [
  { value: ALL, label: "全部结果" },
  { value: "pass", label: "🟢 通过" },
  { value: "changes_requested", label: "🔴 需修改" },
  { value: "failed", label: "失败" },
];
const SOURCE_ITEMS: SelectItem[] = [
  { value: ALL, label: "全部来源" },
  { value: "slack", label: "Slack" },
  { value: "web", label: "Web" },
];

type ReviewListPageProps = {
  search: ReviewSearch;
  onSearchChange: (next: ReviewSearch) => void;
};

/** /review (FR-REVIEW-06): review history, filterable and paged. View-only (Q26, decided). */
export function ReviewListPage({ search, onSearchChange }: ReviewListPageProps) {
  const query = useInfiniteQuery({
    ...reviewListQueryOptions(search),
    // A filter change keeps the old rows until the new ones arrive.
    placeholderData: keepPreviousData,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const repos = query.data?.pages[0]?.repos ?? [];
  const filtered = hasFilters(search);

  const set = <K extends keyof ReviewSearch>(key: K, value: ReviewSearch[K] | undefined) => {
    const next: ReviewSearch = { ...search };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    onSearchChange(next);
  };
  const clear = () => onSearchChange({});

  const repoItems: SelectItem[] = [
    { value: ALL, label: "全部仓库" },
    ...[...new Set([...repos, ...(search.repo ? [search.repo] : [])])].map((r) => ({
      value: r,
      label: r,
    })),
  ];

  return (
    <Page>
      <Intro>
        <Kicker>Github</Kicker>
        <Title>Review</Title>
        <Description>
          评审记录（只读）。批准、强制批准和重新评审只能在 Slack 线程里回复；合并在 Merge 页面。
        </Description>
      </Intro>

      <Filters>
        <Field>
          <FieldLabel id="review-filter-repo">仓库</FieldLabel>
          <Select
            aria-labelledby="review-filter-repo"
            items={repoItems}
            value={search.repo ?? ALL}
            onValueChange={(v) => set("repo", v && v !== ALL ? v : undefined)}
          />
        </Field>
        <Field>
          <FieldLabel id="review-filter-outcome">结果</FieldLabel>
          <Select
            aria-labelledby="review-filter-outcome"
            items={OUTCOME_ITEMS}
            value={search.outcome ?? ALL}
            onValueChange={(v) =>
              set("outcome", v && v !== ALL ? (v as ReviewSearch["outcome"]) : undefined)
            }
          />
        </Field>
        <Field>
          <FieldLabel id="review-filter-source">来源</FieldLabel>
          <Select
            aria-labelledby="review-filter-source"
            items={SOURCE_ITEMS}
            value={search.source ?? ALL}
            onValueChange={(v) =>
              set("source", v && v !== ALL ? (v as ReviewSearch["source"]) : undefined)
            }
          />
        </Field>
        <Label>
          开始日期
          <Input
            type="date"
            value={search.from ?? ""}
            max={search.to}
            onChange={(e) => set("from", e.currentTarget.value || undefined)}
          />
        </Label>
        <Label>
          结束日期
          <Input
            type="date"
            value={search.to ?? ""}
            min={search.from}
            onChange={(e) => set("to", e.currentTarget.value || undefined)}
          />
        </Label>
        {filtered ? (
          <Button variant="ghost" onClick={clear}>
            清除筛选
          </Button>
        ) : null}
      </Filters>

      {query.isPending ? (
        <Skeleton lines={6} aria-label="正在加载评审记录" />
      ) : query.isError && items.length === 0 ? (
        <Alert
          tone="danger"
          title="评审记录加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              <Refresh />
              重试
            </Button>
          }
        >
          {reviewErrorText(query.error, "无法读取评审记录")}
        </Alert>
      ) : items.length === 0 ? (
        filtered ? (
          <Empty description="没有符合筛选条件的评审。">
            <Button variant="secondary" size="sm" onClick={clear}>
              清除筛选
            </Button>
          </Empty>
        ) : (
          <Empty description="还没有评审记录。" />
        )
      ) : (
        <>
          <Rows aria-label="评审记录" aria-busy={query.isFetching || undefined}>
            {items.map((item) => (
              <ReviewRow key={item.id} item={item} />
            ))}
          </Rows>
          {query.isFetchNextPageError ? (
            <Alert tone="danger" title="加载更多失败">
              {reviewErrorText(query.error, "无法读取更多评审记录")}
            </Alert>
          ) : null}
          {query.hasNextPage ? (
            <More>
              <Button
                variant="secondary"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                加载更多
              </Button>
            </More>
          ) : null}
        </>
      )}
    </Page>
  );
}

function ReviewRow({ item }: { item: ReviewListItem }) {
  const marker = markerText(item.marker);
  return (
    <Row>
      <RowMain>
        <PrLink to="/review/$reviewId" params={{ reviewId: item.id }}>
          {`${item.repo}#${item.number}`}
        </PrLink>
        {item.status === "failed" ? (
          <Tag tone="danger">失败</Tag>
        ) : marker ? (
          <Marker>{marker}</Marker>
        ) : null}
        {item.merged ? <Tag tone="success">{MERGED_TEXT}</Tag> : null}
        {item.findingCounts.length > 0 ? (
          <Counts>{item.findingCounts.map((c) => `${c.severity} × ${c.count}`).join(" · ")}</Counts>
        ) : null}
      </RowMain>
      <RowMeta>
        {item.shortSha ? <Code>{item.shortSha}</Code> : null}
        <Tag tone="neutral">{item.source}</Tag>
        <span>{requesterText(item.requester)}</span>
        <span>{approvalText(item.approval)}</span>
        <Time dateTime={item.finishedAt}>{formatTime(item.finishedAt)}</Time>
      </RowMeta>
    </Row>
  );
}
