import type {
  GateView,
  MergeGatesView,
  MergeHistoryItem,
  MergeHistoryView,
  MergeQueueItem,
  MergeQueueView,
} from "../../../functions/merge.logic";

export const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const PR_URL = "https://github.com/acme/web/pull/7";

export const aQueueItem = (over: Partial<MergeQueueItem> = {}): MergeQueueItem => ({
  prUrl: PR_URL,
  repo: "acme/web",
  number: 7,
  reviewId: "rev-1",
  reviewedSha: SHA,
  shortSha: "a1b2c3d",
  verdict: "pass",
  forceApproved: false,
  reviewedAt: "2026-11-04T02:00:00.000Z",
  source: "slack",
  title: "Add login",
  author: "alice",
  ...over,
});

export const aQueue = (over: Partial<MergeQueueView> = {}): MergeQueueView => ({
  github: "ready",
  items: [aQueueItem()],
  ...over,
});

export const ALL_PASS: GateView[] = [
  { id: "allowlist", status: "pass" },
  { id: "open", status: "pass" },
  { id: "not_draft", status: "pass" },
  { id: "approved_at_sha", status: "pass" },
  { id: "no_p0", status: "pass" },
  { id: "checks_green", status: "pass" },
  { id: "mergeable", status: "pass" },
];

export const someGates = (over: Partial<Record<GateView["id"], GateView["status"]>>) =>
  ALL_PASS.map((g) => ({ id: g.id, status: over[g.id] ?? g.status }));

export const aGates = (over: Partial<MergeGatesView> = {}): MergeGatesView => ({
  prUrl: PR_URL,
  headSha: SHA,
  shortSha: "a1b2c3d",
  state: "open",
  gates: ALL_PASS,
  canMerge: true,
  blockedReason: null,
  mergeableState: "clean",
  checks: { state: "green", failing: [], pending: [] },
  p0Waived: false,
  ...over,
});

export const aHistoryItem = (over: Partial<MergeHistoryItem> = {}): MergeHistoryItem => ({
  id: "evt-1",
  prUrl: "https://github.com/acme/web/pull/5",
  repo: "acme/web",
  number: 5,
  sha: SHA,
  mergeSha: "ffffffffffffffffffffffffffffffffffffffff",
  actor: { kind: "user", id: "user-1", self: true },
  source: "web",
  at: "2026-11-04T03:00:00.000Z",
  reviewId: "rev-0",
  ...over,
});

export const aHistory = (over: Partial<MergeHistoryView> = {}): MergeHistoryView => ({
  items: [aHistoryItem()],
  hasMore: false,
  ...over,
});
