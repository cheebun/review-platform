import type { PrRef } from "../domain/github/pr-ref";
import type { ReviewDiffFile } from "../domain/review/types";
import type { DomainError, Result } from "../domain/shared/result";

export type RepoRef = { owner: string; repo: string };

export type PullRequestState = "open" | "closed";

/**
 * GitHub's `mergeable_state`. Anything GitHub adds later, and the state while GitHub is still
 * computing, is `unknown`.
 */
export const MERGEABLE_STATES = [
  "clean",
  "dirty",
  "blocked",
  "behind",
  "unstable",
  "has_hooks",
  "draft",
  "unknown",
] as const;
export type MergeableState = (typeof MERGEABLE_STATES)[number];

export const toMergeableState = (value: unknown): MergeableState =>
  typeof value === "string" && (MERGEABLE_STATES as readonly string[]).includes(value)
    ? (value as MergeableState)
    : "unknown";

/**
 * Upper bound on PR reads for `getPullRequest(ref, { awaitMergeable: true })`, the first read
 * included. GitHub computes `mergeable` in the background and answers `null` until it is done.
 */
export const MERGEABLE_MAX_READS = 4;

export type GetPullRequestOptions = {
  /**
   * Re-read an open PR while GitHub reports `mergeable: null`, at most `MERGEABLE_MAX_READS`
   * reads with a short backoff. Still `null` after that means unknown, never mergeable. A re-read
   * that fails returns the earlier read. Only the merge path needs it; other callers do not wait.
   */
  awaitMergeable?: boolean;
};

export type PullRequestMeta = {
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  /** Head commit SHA. */
  sha: string;
  baseSha: string;
  state: PullRequestState;
  merged: boolean;
  draft: boolean;
  changedFiles: number;
  htmlUrl: string;
  /** GitHub's `mergeable`; `null` while GitHub is still computing it (unknown). */
  mergeable: boolean | null;
  mergeableState: MergeableState;
};

export type OpenPullRequest = {
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  draft: false;
  updatedAt: string;
  base: string;
  head: string;
  /** GitHub reviewDecision === APPROVED. */
  approved: boolean;
};

export type ListOpenOptions = {
  /** Case-insensitive author allowlist. */
  authors: readonly string[];
  maxAgeDays: number;
  /** Injected clock reading; the adapter never reads the system clock for this. */
  now: Date;
};

export type PullRequestDiff = {
  meta: PullRequestMeta;
  files: ReviewDiffFile[];
  /** False when the file list is short or a file's patch could not be recovered. */
  complete: boolean;
  incompleteReason?: string;
};

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export type SubmitReviewInput = {
  event: ReviewEvent;
  /** Optional for APPROVE; REQUEST_CHANGES and COMMENT get an invisible placeholder when empty. */
  body?: string;
  /** Pins the review to the reviewed head SHA. */
  commitId?: string;
};

export type FoundReview = { id: number; commitId: string | null; state: ReviewState };

export type MergeResult = { merged: true; sha: string };

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export type MergeOptions = {
  /** Head SHA the merge is pinned to; GitHub rejects the merge when the head moved. */
  sha: string;
  /**
   * Per-call override. When absent the adapter picks the first method from its configured
   * preference list that the repository allows. There is no built-in default.
   */
  method?: MergeMethod;
};

export type ChecksState = "green" | "pending" | "failing";

/**
 * Check runs and commit statuses at one commit, aggregated. Neutral and skipped check runs count
 * as success. `total` is the number of distinct checks seen, so a caller can tell "no CI at all"
 * (green with total 0) from "everything passed".
 */
export type ChecksSummary = {
  state: ChecksState;
  failing: string[];
  pending: string[];
  total: number;
};

/** `GET /user/repos` page size, and the most pages one listing reads. */
export const ACCESSIBLE_REPOS_PAGE_SIZE = 100;
export const ACCESSIBLE_REPOS_MAX_PAGES = 10;
/** Wall-clock budget for one whole listing, every page included. */
export const ACCESSIBLE_REPOS_BUDGET_MS = 15_000;

/** A repository the token can access, as `GET /user/repos` reports it. */
export type AccessibleRepo = {
  /** `owner/repo` exactly as GitHub spells it. */
  fullName: string;
  private: boolean;
  archived: boolean;
  /** The token's account may push (`permissions.push`); false when GitHub does not say. */
  canPush: boolean;
};

export type AccessibleRepoList = {
  repos: AccessibleRepo[];
  /** True when the page cap or the time budget stopped the listing before its end. */
  truncated: boolean;
};

export type ListAccessibleReposOptions = { signal?: AbortSignal };

/**
 * Every method returns a Result and never throws.
 * Errors: `forbidden` (401/403), `not_found` (404), `conflict` (stale SHA, not mergeable, PR
 * changed while reading), `rate_limited`, `upstream` (5xx, network, timeout), `validation` (422).
 */
export interface GitHubPort {
  listOpenPullRequests(
    repo: RepoRef,
    options: ListOpenOptions,
  ): Promise<Result<OpenPullRequest[], DomainError>>;
  getPullRequest(
    ref: PrRef,
    options?: GetPullRequestOptions,
  ): Promise<Result<PullRequestMeta, DomainError>>;
  getAuthenticatedLogin(): Promise<Result<string, DomainError>>;
  /**
   * The repositories the token can access (owner, collaborator, organization member), sorted by
   * full name, at most `ACCESSIBLE_REPOS_MAX_PAGES` pages within `ACCESSIBLE_REPOS_BUDGET_MS`.
   * Read-only. A fine-grained token lists only the repositories it was granted.
   */
  listAccessibleRepos(
    options?: ListAccessibleReposOptions,
  ): Promise<Result<AccessibleRepoList, DomainError>>;
  /** Full diff at one consistent head/base; `conflict` when the PR moved while it was read. */
  getDiff(ref: PrRef): Promise<Result<PullRequestDiff, DomainError>>;
  /** First Conversation comment whose body contains `marker`. */
  findCommentByMarker(
    ref: PrRef,
    marker: string,
  ): Promise<Result<{ id: number } | null, DomainError>>;
  createComment(ref: PrRef, body: string): Promise<Result<{ id: number }, DomainError>>;
  /**
   * Latest (highest id) review by the authenticated user whose body contains `marker`
   * (an empty marker matches any body), optionally restricted to a commit and state.
   */
  findReviewByMarker(
    ref: PrRef,
    marker: string,
    filter?: { commitId?: string; state?: ReviewState },
  ): Promise<Result<FoundReview | null, DomainError>>;
  submitReview(ref: PrRef, input: SubmitReviewInput): Promise<Result<{ id: number }, DomainError>>;
  /** Aggregated check runs and commit statuses at `sha`, all pages. */
  getChecks(repo: RepoRef, sha: string): Promise<Result<ChecksSummary, DomainError>>;
  /**
   * True when the authenticated account's latest state-bearing review (APPROVED or
   * CHANGES_REQUESTED; dismissed, pending and comment-only reviews are ignored) is APPROVED and
   * was made on `sha`.
   */
  hasApproval(ref: PrRef, sha: string): Promise<Result<boolean, DomainError>>;
  /**
   * Merge pinned to `sha`. A SHA mismatch, a disallowed method or a PR that cannot be merged is
   * `conflict` with GitHub's reason; no merge method configured is `validation`.
   */
  merge(ref: PrRef, options: MergeOptions): Promise<Result<MergeResult, DomainError>>;
}
