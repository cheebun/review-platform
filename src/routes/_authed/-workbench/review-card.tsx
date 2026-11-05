import { useQuery } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import { useId } from "react";
import type { LatestReview, ReviewSummaryView } from "../../../functions/workbench.logic";
import { Empty, Tag, twx } from "../../../ui";
import { formatTime, markerText } from "../-review/format";
import { Card, CardError, CardLink, CardLoading } from "./card";
import { reviewSummaryQueryOptions } from "./queries";

const Body = twx("div")(() => "flex flex-col gap-4");
const Caption = twx("p")(() => "text-body-sm text-secondary-text");
const Counts = twx("ul")(() => "grid grid-cols-3 gap-3");
const CountAnchor = twx("a")(
  () =>
    "flex flex-col gap-1 rounded-md border border-border px-3 py-2 outline-none hover:bg-hover-fill focus-visible:ring-2 focus-visible:ring-primary",
);
const CountLink = createLink(CountAnchor);
const CountLabel = twx("span")(() => "text-label-sm text-secondary-text");
const CountValue = twx("span")(() => "text-headline-sm tabular-nums text-heading");
const Rows = twx("ul")(() => "flex flex-col divide-y divide-border");
const Row = twx("li")(() => "flex flex-wrap items-center gap-x-3 gap-y-1 py-2");
const Time = twx("time")(() => "ml-auto text-body-sm tabular-nums text-secondary-text");
const Marker = twx("span")(() => "text-body-sm text-heading");
const SubTitle = twx("h3")(() => "text-label-md text-secondary-text");

type Outcome = keyof ReviewSummaryView["counts"];
const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: "pass", label: "🟢 通过" },
  { key: "changes_requested", label: "🔴 需修改" },
  { key: "failed", label: "失败" },
];

/** `MM-DD` of a `YYYY-MM-DD` day. */
const shortDay = (day: string) => day.slice(5);

/** Review summary: counts by outcome over the last 7 UTC+8 days and the latest reviews. */
export function ReviewCard({ className }: { className?: string }) {
  const query = useQuery(reviewSummaryQueryOptions());
  return (
    <Card title="评审" className={className} link={<CardLink to="/review">查看全部评审</CardLink>}>
      {query.isPending ? (
        <CardLoading label="正在加载评审概况" lines={5} />
      ) : query.isError ? (
        <CardError
          error={query.error}
          action="评审概况加载失败"
          onRetry={() => void query.refetch()}
        />
      ) : (
        <ReviewSummary view={query.data} />
      )}
    </Card>
  );
}

function ReviewSummary({ view }: { view: ReviewSummaryView }) {
  const { from, to, days } = view.window;
  const countsLabel = `最近 ${days} 天评审结果`;
  const latestId = useId();
  return (
    <Body>
      <Caption>
        最近 {days} 天：{shortDay(from)} 至 {shortDay(to)}（UTC+8）
      </Caption>
      <Counts aria-label={countsLabel}>
        {OUTCOMES.map(({ key, label }) => (
          <li key={key}>
            <CountLink to="/review" search={{ outcome: key, from, to }}>
              <CountLabel>{label}</CountLabel>
              <CountValue>
                {view.counts[key]}
                {view.truncated ? "+" : ""}
              </CountValue>
            </CountLink>
          </li>
        ))}
      </Counts>
      {view.latest.length === 0 ? (
        <Empty description="还没有评审记录。" />
      ) : (
        <>
          <SubTitle id={latestId}>最近评审</SubTitle>
          <Rows aria-labelledby={latestId}>
            {view.latest.map((item) => (
              <LatestRow key={item.id} item={item} />
            ))}
          </Rows>
        </>
      )}
    </Body>
  );
}

function LatestRow({ item }: { item: LatestReview }) {
  const marker = markerText(item.verdict);
  return (
    <Row>
      <CardLink to="/review/$reviewId" params={{ reviewId: item.id }}>
        {`${item.repo}#${item.number}`}
      </CardLink>
      {item.status === "failed" ? (
        <Tag tone="danger">失败</Tag>
      ) : marker ? (
        <Marker>{marker}</Marker>
      ) : null}
      <Time dateTime={item.finishedAt}>{formatTime(item.finishedAt)}</Time>
    </Row>
  );
}
