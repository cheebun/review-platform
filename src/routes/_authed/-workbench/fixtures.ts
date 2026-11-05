import type {
  LatestReview,
  MergeSummaryView,
  ReviewSummaryView,
  SetupStatusView,
} from "../../../functions/workbench.logic";

export const aLatestReview = (over: Partial<LatestReview> = {}): LatestReview => ({
  id: "rev-1",
  repo: "acme/web",
  number: 7,
  status: "completed",
  verdict: "pass",
  finishedAt: "2026-11-05T02:00:00.000Z",
  ...over,
});

export const aReviewSummary = (over: Partial<ReviewSummaryView> = {}): ReviewSummaryView => ({
  window: { from: "2026-10-30", to: "2026-11-05", days: 7 },
  counts: { pass: 4, changes_requested: 2, failed: 1 },
  truncated: false,
  latest: [
    aLatestReview(),
    aLatestReview({ id: "rev-2", number: 8, verdict: "changes_requested" }),
    aLatestReview({ id: "rev-3", number: 9, status: "failed", verdict: null }),
  ],
  ...over,
});

export const aMergeSummary = (over: Partial<MergeSummaryView> = {}): MergeSummaryView => ({
  github: "ready",
  awaiting: 3,
  passing: 2,
  capped: false,
  ...over,
});

export const aSetupStatus = (over: Partial<SetupStatusView> = {}): SetupStatusView => ({
  github: "configured",
  slack: "configured",
  llm: "configured",
  ...over,
});
