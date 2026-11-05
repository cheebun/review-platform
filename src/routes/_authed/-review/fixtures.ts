import type {
  ReviewDetailView,
  ReviewListItem,
  ReviewListView,
} from "../../../functions/review.logic";

export const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

export const aListItem = (over: Partial<ReviewListItem> = {}): ReviewListItem => ({
  id: "rev-1",
  prUrl: "https://github.com/acme/web/pull/7",
  repo: "acme/web",
  number: 7,
  headSha: SHA,
  shortSha: "a1b2c3d",
  source: "slack",
  requester: { kind: "slack", id: "U123", self: false },
  finishedAt: "2026-11-04T02:00:00.000Z",
  status: "completed",
  verdict: "pass",
  marker: "pass",
  merged: false,
  approval: { kind: "approved", at: "2026-11-04T02:01:00.000Z", sha: SHA, source: "system" },
  findingCounts: [],
  ...over,
});

export const aListView = (over: Partial<ReviewListView> = {}): ReviewListView => ({
  items: [aListItem()],
  nextCursor: null,
  repos: ["acme/web", "acme/api"],
  ...over,
});

export const aDetailView = (
  over: Partial<Omit<ReviewDetailView, "review">> & {
    review?: Partial<ReviewDetailView["review"]>;
  } = {},
): ReviewDetailView => {
  const { review, ...rest } = over;
  return {
    review: {
      ...aListItem(),
      baseSha: null,
      provider: "anthropic",
      model: "claude-x",
      startedAt: "2026-11-04T01:58:00.000Z",
      summary: "Looks fine.",
      errorCategory: null,
      ...review,
    },
    githubUrl: "https://github.com/acme/web/pull/7",
    findingGroups: [],
    timeline: [],
    newerReview: null,
    ...rest,
  };
};
