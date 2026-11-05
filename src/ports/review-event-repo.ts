/** Settings-change events (FR-GITHUB-04, FR-GITHUB-07, FR-SLACKCFG-02). */
export type SettingsEventType =
  | "github_token_saved"
  | "github_token_replaced"
  | "github_token_removed"
  | "github_repo_added"
  | "github_repo_removed"
  | "slack_secret_saved"
  | "slack_secret_removed"
  | "slack_channels_changed"
  | "settings_value_saved"
  | "settings_value_removed";

/** Review, approval and merge steps (FR-REVIEW-06, FR-SHIP-01..08). */
export type ReviewStepEventType =
  | "review_started"
  | "review_finished"
  | "review_failed"
  | "comment_posted"
  | "changes_requested"
  | "approved"
  | "approve_skipped"
  | "approve_failed"
  | "force_approved"
  | "merged"
  | "merge_failed";

export type ReviewEventType = SettingsEventType | ReviewStepEventType;

export type EventActor = { kind: "user" | "machine" | "system"; id: string };

/** Small, non-secret facts only (login, last 4, repo name). Never a token or a response body. */
export type EventDetail = Record<string, string | number | boolean | null>;

export type NewReviewEvent = {
  id: string;
  type: ReviewEventType;
  actor: EventActor;
  at: Date;
  prUrl?: string;
  reviewId?: string;
  /** With `prUrl` and `type`, the idempotency key of a review step. */
  jobId?: string;
  sha?: string;
  reason?: string;
  source?: "web" | "slack" | "system";
  detail?: EventDetail;
};

export type ReviewEventRecord = Required<Pick<NewReviewEvent, "id" | "type" | "actor" | "at">> &
  Omit<NewReviewEvent, "id" | "type" | "actor" | "at">;

export type ReviewEventFilter = {
  types?: readonly ReviewEventType[];
  /** The timeline of one PR (`/review/$reviewId`, `/merge`). */
  prUrl?: string;
  reviewId?: string;
  limit: number;
};

/**
 * Append-only history (`review_event`, FR-REVIEW-06). There is no update or delete: the PG table
 * also denies both with a trigger. A second event with the same (jobId, prUrl, type) is ignored.
 */
export interface ReviewEventRepo {
  append(event: NewReviewEvent): Promise<{ inserted: boolean }>;
  /** Newest first. Filters combine with AND. */
  list(filter: ReviewEventFilter): Promise<ReviewEventRecord[]>;
}
