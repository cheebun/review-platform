import { twx } from "../../../ui";
import { MergeCard } from "./merge-card";
import { ReviewCard } from "./review-card";
import { SetupCard } from "./setup-card";

const Page = twx("div")(() => "flex flex-col gap-6");
const Intro = twx("div")(() => "flex flex-col gap-1");
const Title = twx("h1")(() => "text-headline-lg text-heading");
const Description = twx("p")(() => "max-w-3xl text-body-md text-secondary-text");
const Grid = twx("div")(() => "grid grid-cols-1 gap-6 lg:grid-cols-3");
const wide = "lg:col-span-2";

/**
 * Overview `/` (docs/product.md §4.2): a summary dashboard. Each card loads, fails and retries on
 * its own, so one failing source never breaks the page.
 */
export function WorkbenchPage() {
  return (
    <Page>
      <Intro>
        <Title>Overview</Title>
        <Description>最近的评审、待合并的 PR 和设置状态。</Description>
      </Intro>
      <Grid>
        <ReviewCard className={wide} />
        <MergeCard />
        <SetupCard />
      </Grid>
    </Page>
  );
}
