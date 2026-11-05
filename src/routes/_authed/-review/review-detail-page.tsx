import { useQuery } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import type { FindingView, ReviewDetailView, TimelineItem } from "../../../functions/review.logic";
import { Alert, Code, Empty, LinkIcon, Skeleton, Tag, TextLink, twx } from "../../../ui";
import {
  approvalText,
  eventLabel,
  formatTime,
  markerText,
  MERGED_TEXT,
  requesterText,
  severityLabel,
} from "./format";
import { isNotFound, reviewDetailQueryOptions } from "./queries";
import { reviewErrorText } from "./review-errors";

const Page = twx("div")(() => "flex flex-col gap-6");
const Header = twx("div")(() => "flex flex-col gap-2");
const TitleRow = twx("div")(() => "flex flex-wrap items-center gap-3");
const Title = twx("h1")(() => "font-mono text-headline-lg text-heading");
const Badges = twx("div")(() => "flex flex-wrap items-center gap-2");
const Marker = twx("span")(() => "text-title-md text-heading");
const Section = twx("section")(
  () => "flex flex-col gap-3 rounded-lg border border-border bg-surface p-card-padding-x",
);
const SectionTitle = twx("h2")(() => "text-title-md text-heading");
const Meta = twx("dl")(() => "grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-body-sm");
const MetaKey = twx("dt")(() => "text-secondary-text");
const MetaValue = twx("dd")(() => "min-w-0 break-all text-on-surface");
const Prose = twx("p")(() => "whitespace-pre-wrap break-words text-body-md text-on-surface");
const Hint = twx("p")(() => "text-body-sm text-secondary-text");
const Group = twx("section")(() => "flex flex-col gap-2");
const GroupTitle = twx("h3")(() => "text-label-md text-heading");
const FindingList = twx("ul")(() => "flex flex-col gap-2");
const FindingItem = twx("li")(
  () => "flex flex-col gap-1 rounded-md border border-border bg-background px-3 py-2",
);
const FindingHead = twx("div")(() => "flex flex-wrap items-center gap-2");
const FindingTitle = twx("strong")(() => "font-semibold text-heading");
const Timeline = twx("ol")(() => "flex flex-col gap-2 border-l border-border pl-4");
const TimelineEntry = twx("li")(() => "flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm");
const EventName = twx("span")(() => "font-medium text-heading");
const Muted = twx("span")(() => "text-secondary-text");
const Time = twx("time")(() => "tabular-nums text-secondary-text");
const Anchor = twx("a")(
  () =>
    "text-primary-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
);
const AppLink = createLink(Anchor);
const External = twx(LinkIcon).attrs({ "aria-hidden": true })(() => "size-4");

const BackLink = () => <AppLink to="/review">返回评审记录</AppLink>;

/** /review/$reviewId (FR-REVIEW-07). Read-only: no buttons, forms or writes (decided). */
export function ReviewDetailPage({ reviewId }: { reviewId: string }) {
  const query = useQuery(reviewDetailQueryOptions(reviewId));

  if (query.isPending) {
    return (
      <Page>
        <BackLink />
        <Skeleton lines={8} aria-label="正在加载评审详情" />
      </Page>
    );
  }
  if (query.isError) {
    if (isNotFound(query.error)) return <ReviewNotFound />;
    return (
      <Page>
        <BackLink />
        <Alert tone="danger" title="评审详情加载失败">
          {reviewErrorText(query.error, "无法读取这条评审")}
        </Alert>
      </Page>
    );
  }
  return <ReviewDetail view={query.data} />;
}

/** The 404 view: an unknown id, or a record of a repo outside the settings list. */
export function ReviewNotFound() {
  return (
    <Page>
      <BackLink />
      <Title>找不到这条评审</Title>
      <Empty description="这条评审不存在，或它所属的仓库已不在设置的仓库列表中。" />
    </Page>
  );
}

function ReviewDetail({ view }: { view: ReviewDetailView }) {
  const { review } = view;
  const marker = markerText(review.marker);
  const failed = review.status === "failed";
  const findingCount = view.findingGroups.reduce((n, g) => n + g.findings.length, 0);

  return (
    <Page>
      <BackLink />
      <Header>
        <TitleRow>
          <Title>{`${review.repo}#${review.number}`}</Title>
          {view.githubUrl ? (
            <TextLink external href={view.githubUrl}>
              <External /> 在 GitHub 打开
            </TextLink>
          ) : null}
        </TitleRow>
        <Badges>
          {failed ? <Tag tone="danger">评审失败</Tag> : marker ? <Marker>{marker}</Marker> : null}
          {review.merged ? <Tag tone="success">{MERGED_TEXT}</Tag> : null}
          <Tag tone="neutral">{review.source}</Tag>
        </Badges>
      </Header>

      {view.newerReview ? (
        <Alert tone="warning" title="PR 有新提交，这条评审已过期">
          在 Slack 线程回复 review 或 updated 以重新评审。{" "}
          <AppLink to="/review/$reviewId" params={{ reviewId: view.newerReview.id }}>
            查看最新评审
          </AppLink>
          {view.newerReview.shortSha ? <Muted>{` @ ${view.newerReview.shortSha}`}</Muted> : null}
        </Alert>
      ) : null}

      <Section aria-labelledby="review-meta">
        <SectionTitle id="review-meta">概要</SectionTitle>
        <Meta>
          <MetaKey>Head SHA</MetaKey>
          <MetaValue>{review.headSha ? <Code>{review.headSha}</Code> : "—"}</MetaValue>
          {review.baseSha ? (
            <>
              <MetaKey>Base SHA</MetaKey>
              <MetaValue>
                <Code>{review.baseSha}</Code>
              </MetaValue>
            </>
          ) : null}
          <MetaKey>请求人</MetaKey>
          <MetaValue>{requesterText(review.requester)}</MetaValue>
          <MetaKey>模型</MetaKey>
          <MetaValue>
            {[review.provider, review.model].filter(Boolean).join(" / ") || "—"}
          </MetaValue>
          <MetaKey>开始</MetaKey>
          <MetaValue>
            <Time dateTime={review.startedAt}>{formatTime(review.startedAt)}</Time>
          </MetaValue>
          <MetaKey>完成</MetaKey>
          <MetaValue>
            <Time dateTime={review.finishedAt}>{formatTime(review.finishedAt)}</Time>
          </MetaValue>
          {failed ? (
            <>
              <MetaKey>失败原因</MetaKey>
              <MetaValue>
                <Code>{review.errorCategory ?? "unknown"}</Code>
              </MetaValue>
            </>
          ) : null}
        </Meta>
        {review.summary ? <Prose>{review.summary}</Prose> : null}
      </Section>

      {failed ? null : (
        <Section aria-labelledby="review-approval">
          <SectionTitle id="review-approval">批准</SectionTitle>
          <Prose>
            {approvalText(review.approval)}
            {review.approval?.sha ? <Muted>{` @ ${review.approval.sha.slice(0, 7)}`}</Muted> : null}
            {review.approval ? <Muted>{` · ${formatTime(review.approval.at)}`}</Muted> : null}
          </Prose>
          {review.approval?.kind === "skipped" || review.approval?.kind === "failed" ? (
            <Hint>可在 Slack 线程回复 approve 重新批准。</Hint>
          ) : null}
          {review.verdict === "changes_requested" && review.approval?.kind !== "force_approved" ? (
            <Hint>评审要求修改。只有在 Slack 线程回复 force approve 才能覆盖。</Hint>
          ) : null}
        </Section>
      )}

      <Section aria-labelledby="review-findings">
        <SectionTitle id="review-findings">{`问题 · ${findingCount}`}</SectionTitle>
        {findingCount === 0 ? (
          <Empty description="没有发现问题。" />
        ) : (
          view.findingGroups.map((group) => (
            <FindingGroup
              key={group.severity}
              severity={group.severity}
              findings={group.findings}
            />
          ))
        )}
      </Section>

      <Section aria-labelledby="review-timeline">
        <SectionTitle id="review-timeline">事件</SectionTitle>
        {view.timeline.length === 0 ? (
          <Empty description="还没有事件。" />
        ) : (
          <Timeline aria-label="事件时间线">
            {view.timeline.map((item) => (
              <TimelineRow key={item.id} item={item} />
            ))}
          </Timeline>
        )}
      </Section>
    </Page>
  );
}

function FindingGroup({ severity, findings }: { severity: string; findings: FindingView[] }) {
  const id = `review-sev-${severity.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <Group aria-labelledby={id}>
      <GroupTitle id={id}>{`${severityLabel(severity)} · ${findings.length}`}</GroupTitle>
      <FindingList>
        {findings.map((f, i) => {
          const location = f.path ? `${f.path}${f.line !== undefined ? `:${f.line}` : ""}` : null;
          return (
            <FindingItem key={i}>
              <FindingHead>
                <FindingTitle>{f.title}</FindingTitle>
                {location && f.href ? (
                  <TextLink external href={f.href}>
                    <Code>{location}</Code>
                  </TextLink>
                ) : location ? (
                  <Code>{location}</Code>
                ) : null}
              </FindingHead>
              {f.body ? <Prose>{f.body}</Prose> : null}
            </FindingItem>
          );
        })}
      </FindingList>
    </Group>
  );
}

const actorText = (a: TimelineItem["actor"]) =>
  a.kind === "user" ? `用户 ${a.id}` : a.kind === "machine" ? "machine" : `system (${a.id})`;

function TimelineRow({ item }: { item: TimelineItem }) {
  return (
    <TimelineEntry>
      <EventName>{eventLabel(item.type)}</EventName>
      <Muted>{actorText(item.actor)}</Muted>
      {item.source ? <Tag tone="neutral">{item.source}</Tag> : null}
      {item.sha ? <Code>{item.sha.slice(0, 7)}</Code> : null}
      {item.reason ? <Muted>{item.reason}</Muted> : null}
      <Time dateTime={item.at}>{formatTime(item.at)}</Time>
    </TimelineEntry>
  );
}
