export type Severity = "P0" | "P1" | "P2" | "Nit";

export type Finding = {
  severity: Severity;
  title: string;
  body: string;
  /** Chinese copy for the local UI modal. */
  titleZh?: string;
  bodyZh?: string;
  path?: string;
  line?: number;
};

export type AiReviewResult = {
  summary: string;
  /** Chinese summary for the local UI modal. */
  summaryZh?: string;
  findings: Finding[];
  verificationRequests: string[];
  /** Chinese verification items for the local UI modal. */
  verificationRequestsZh?: string[];
};

export type GithubReviewEvent = "APPROVE" | "REQUEST_CHANGES";

export type ReviewDiffFile = {
  header: string;
  patch: string;
};

/** The review outcome shown as 🟢 (`pass`) or 🔴 (`changes_requested`). Derived, never stored by hand. */
export type ReviewVerdict = "pass" | "changes_requested";

/** Terminal outcome of the auto-approve checkpoint for one PR (FR-SHIP-01). Pinned to `sha`. */
export type ApproveOutcome =
  | { step: "approved"; sha: string; githubReviewId: number }
  | { step: "approve_skipped"; sha: string; reason: string }
  | { step: "approve_failed"; sha: string; reason: string };

/** Auto-approve checkpoint: `approve_pending` is written before the GitHub call, the outcome after it. */
export type ApproveCheckpoint = { step: "approve_pending"; sha: string } | ApproveOutcome;

/** Generic, non-leaking failure category for a failed review record (FR-REVIEW-05 AC 2). */
export type ReviewFailureCategory =
  | "interrupted"
  | "upstream"
  | "validation"
  | "not_configured"
  | "internal";

/** Who asked for the review: a Slack user (Slack jobs) or an app user (web jobs). */
export type ReviewRequester = { kind: "slack"; id: string } | { kind: "user"; id: string };

/**
 * The durable review record (FR-REVIEW-05): one per PR URL per run, produced only by the terminal
 * transition of a review job. `(jobId, prUrl, attempt)` is its natural, idempotent key.
 * Provider and model are not known to the job; the use case adds them.
 */
export type ReviewRecord = {
  jobId: string;
  prUrl: string;
  /** `ReviewJob.attempts` at the terminal transition; unique per run of one job. */
  attempt: number;
  /** Monotonic per PR: a higher sequence supersedes a lower one (latest review wins). */
  reviewSeq: number;
  source: "slack" | "web";
  requester: ReviewRequester | null;
  pr: { owner: string; repo: string; number: number; headSha: string; baseSha: string } | null;
  status: "done" | "failed";
  verdict: ReviewVerdict | null;
  githubEvent: GithubReviewEvent | null;
  highestSeverity: Severity | null;
  summary: string | null;
  findings: Finding[];
  verificationRequests: string[];
  approve: ApproveCheckpoint | null;
  failure: ReviewFailureCategory | null;
  startedAt: Date;
  finishedAt: Date;
};
