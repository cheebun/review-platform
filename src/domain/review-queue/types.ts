/** Review queue domain types. */
import type { ApproveCheckpoint } from "../review/types";

export type { ApproveCheckpoint, ApproveOutcome } from "../review/types";

/**
 * `done` and `failed` are terminal (only `retry` leaves `failed`). There is no reaction step:
 * reactions are handed to the outbox as `ReactionIntent`s at the terminal transition.
 */
export type ReviewJobState = "queued" | "running" | "done" | "failed";

export const TERMINAL_STATES: readonly ReviewJobState[] = ["done", "failed"];

export type ReviewJobSource = "slack" | "web";

export type FindingSeverity = "P0" | "P1" | "P2" | "Nit";

/** Checkpoint snapshot of a review finding (mirrors lib `Finding`). */
export type FindingSnapshot = {
  severity: FindingSeverity;
  title: string;
  body: string;
  titleZh?: string;
  bodyZh?: string;
  path?: string;
  line?: number;
};

/** Checkpoint snapshot of an AI review result (mirrors lib `AiReviewResult`). */
export type ReviewResultSnapshot = {
  summary: string;
  summaryZh?: string;
  findings: FindingSnapshot[];
  verificationRequests: string[];
  verificationRequestsZh?: string[];
};

/** PR metadata pinned at review time (mirrors `ShipProgress.pr`). */
export type PrCheckpoint = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  base: string;
  head: string;
  sha: string;
  baseSha: string;
};

/** Partial batched review, valid only for one diff fingerprint (mirrors `ShipProgress.batchReview`). */
export type BatchReviewCheckpoint = {
  fingerprint: string;
  total: number;
  results: ReviewResultSnapshot[];
};

/**
 * Per-PR-URL checkpoints, a typed superset of today's `ShipProgress`.
 * Booleans are monotonic (once true, never false); `commentId` / `githubReviewId`
 * are write-once, which is what makes GitHub writes idempotent across retries.
 */
export type UrlProgress = {
  reviewed?: boolean;
  commented?: boolean;
  submitted?: boolean;
  merged?: boolean;
  replied?: boolean;
  reacted?: boolean;
  /** The URL's ship finished (`ShipProgress.completed`). */
  completed?: boolean;
  pr?: PrCheckpoint;
  review?: ReviewResultSnapshot;
  batchReview?: BatchReviewCheckpoint;
  commentId?: number;
  githubReviewId?: number;
  /** Final ship result, opaque to the state machine. */
  result?: unknown;
  /** Monotonic per PR, set once at enqueue (`initialProgress`). The higher sequence wins for emoji. */
  reviewSeq?: number;
  /** Auto-approve checkpoint, pinned to `pr.sha`. Written only by the `approve_*` events. */
  approve?: ApproveCheckpoint;
  /** A completed URL's review record was emitted; later runs of the job never record it again. */
  recorded?: boolean;
};

/** The status a PR's Slack message should converge to. The emoji mapping is the slack domain's. */
export type ReviewStatusTarget = "reviewing" | "pass" | "changes_requested" | "none";

/**
 * What the domain asks the reaction outbox to converge to, per PR. Intents with a lower
 * `reviewSeq` than the latest one for the same PR are superseded (latest review wins).
 */
export type ReactionIntent = {
  prUrl: string;
  jobId: string;
  reviewSeq: number;
  /** The status message: the original Slack message that carries the PR link. */
  channel: string;
  ts: string;
  target: ReviewStatusTarget;
};

export type ReviewJob = {
  id: string;
  source: ReviewJobSource;
  state: ReviewJobState;
  urls: string[];
  progress: Record<string, UrlProgress>;
  attempts: number;
  nextAttemptAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  /**
   * Slack origin. `threadTs` is the message's thread (the runner replies there);
   * `user` is the sender (SlackReviewMessage.sender).
   */
  slack?: { channel: string; ts: string; threadTs?: string; user?: string };
  /** Web actor (better-auth user id). */
  actorUserId?: string;
  lastError?: string;
  /** The final Slack result or failure reply was sent (after the terminal transition, at most once). */
  resultReplySent?: boolean;
  /** First claim of the current run (cleared by `retry`); the review record's `startedAt`. */
  runStartedAt?: Date;
  /** Runs that ended without saving a final status, e.g. a serverless timeout (slack-review-store.ts). */
  interruptions?: number;
  /** Web sessions expire (review-session.ts TTL); Slack jobs leave this unset. */
  expiresAt?: Date;
  /** Optimistic-lock counter, incremented by the repo on every write. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Fields the repo owns: `version`, `createdAt`, `updatedAt`, the lease and `attempts`. */
export type NewReviewJob = Omit<
  ReviewJob,
  "version" | "createdAt" | "updatedAt" | "attempts" | "leaseOwner" | "leaseUntil" | "nextAttemptAt"
> & { nextAttemptAt?: Date | null };
