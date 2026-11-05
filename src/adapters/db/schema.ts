import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ReviewJobSource, ReviewJobState, UrlProgress } from "../../domain/review-queue/types";
import type { TokenKind } from "../../domain/settings/github-credential";
import type { RepoAccess, RepoPermissions } from "../../domain/settings/permissions";
import type { EventDetail, ReviewEventType } from "../../ports/review-event-repo";
import { loginToken } from "./pg-login-token-store-schema";
import { reactionOutbox, slackReaction } from "./pg-reaction-outbox-schema";
import { reviewResult } from "./pg-review-record-schema";
import { settingSecret, settingValue, slackReviewChannel } from "./pg-settings-store-schema";
import { slackReviewThread } from "./pg-thread-review-index-schema";

// Stage 3 tables live next to their repositories; they are registered here for the migration,
// `truncateAll` and the package index.
export {
  loginToken,
  reactionOutbox,
  reviewResult,
  settingSecret,
  settingValue,
  slackReaction,
  slackReviewChannel,
  slackReviewThread,
};

// No table has a schema prefix: isolation (tests, environments) comes from `search_path`.

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const reviewJob = pgTable(
  "review_job",
  {
    id: text("id").primaryKey(),
    source: text("source").$type<ReviewJobSource>().notNull(),
    state: text("state").$type<ReviewJobState>().notNull(),
    urls: jsonb("urls").$type<string[]>().notNull(),
    progress: jsonb("progress").$type<Record<string, UrlProgress>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at"),
    leaseOwner: text("lease_owner"),
    leaseUntil: tstz("lease_until"),
    slack: jsonb("slack").$type<{
      channel: string;
      ts: string;
      threadTs?: string;
      user?: string;
    }>(),
    actorUserId: text("actor_user_id"),
    lastError: text("last_error"),
    resultReplySent: boolean("result_reply_sent"),
    /** First claim of the current run; cleared by `retry`. The review record's `startedAt`. */
    runStartedAt: tstz("run_started_at"),
    interruptions: integer("interruptions"),
    expiresAt: tstz("expires_at"),
    version: integer("version").notNull().default(1),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    index("review_job_claim_idx").on(t.state, t.nextAttemptAt, t.createdAt),
    index("review_job_lease_idx")
      .on(t.leaseUntil)
      .where(sql`${t.state} = 'running'`),
    index("review_job_created_idx").on(t.createdAt),
  ],
);

export const reviewJobRead = pgTable(
  "review_job_read",
  {
    userId: text("user_id").notNull(),
    jobId: text("job_id").notNull(),
    readAt: tstz("read_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.jobId] })],
);

/** Per-user monotonic "read before" cursor, one row per (user, kind). */
export const readCursor = pgTable(
  "read_cursor",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").$type<"job" | "digest">().notNull(),
    readBefore: tstz("read_before").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

/** JSON of the inert digest tables: kept for existing rows, no code reads or writes them. */
type InertJson = Record<string, unknown>;

export const digestMessage = pgTable(
  "digest_message",
  {
    channel: text("channel").notNull(),
    ts: text("ts").notNull(),
    /** Message time in epoch ms, derived from `ts` (truncated to the millisecond). */
    tsMs: bigint("ts_ms", { mode: "number" }).notNull(),
    day: text("day").notNull(),
    source: text("source").$type<"live" | "search">().notNull(),
    payload: jsonb("payload").$type<InertJson>().notNull(),
    capturedAt: tstz("captured_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.channel, t.ts] }), index("digest_message_ts_ms_idx").on(t.tsMs)],
);

export const digest = pgTable(
  "digest",
  {
    id: text("id").primaryKey(),
    windowStart: tstz("window_start").notNull(),
    windowEnd: tstz("window_end").notNull(),
    generatedAt: tstz("generated_at").notNull(),
    itemCount: integer("item_count").notNull(),
    body: jsonb("body").$type<InertJson>().notNull(),
  },
  (t) => [index("digest_generated_at_idx").on(t.generatedAt)],
);

export const digestRead = pgTable(
  "digest_read",
  {
    userId: text("user_id").notNull(),
    digestId: text("digest_id").notNull(),
    itemKey: text("item_key").notNull(),
    readAt: tstz("read_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.digestId, t.itemKey] })],
);

export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: tstz("updated_at").notNull(),
});

/** The id of the single `github_credential` row. */
export const GITHUB_CREDENTIAL_ID = "github";

/**
 * The one GitHub token, AES-256-GCM encrypted (FR-GITHUB-03). Never holds plaintext. A check
 * constraint pins the table to a single row.
 */
export const githubCredential = pgTable(
  "github_credential",
  {
    id: text("id").primaryKey(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    login: text("login").notNull(),
    avatarUrl: text("avatar_url").notNull(),
    last4: text("last4").notNull(),
    /** Token-level check results: the token kind and, for classic tokens, its scopes. */
    permissions: jsonb("permissions")
      .$type<{ tokenKind: TokenKind; scopes: string[] | null }>()
      .notNull(),
    savedAt: tstz("saved_at").notNull(),
    savedByUserId: text("saved_by_user_id").notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [check("github_credential_singleton", sql`${t.id} = 'github'`)],
);

/** The repo list (FR-GITHUB-07). `canonical` is unique case-insensitively. */
export const githubRepo = pgTable(
  "github_repo",
  {
    canonical: text("canonical").primaryKey(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    access: text("access").$type<RepoAccess>().notNull(),
    permissions: jsonb("permissions").$type<RepoPermissions>(),
    checkedAt: tstz("checked_at"),
    addedAt: tstz("added_at").notNull(),
    addedBy: text("added_by").notNull(),
  },
  (t) => [
    uniqueIndex("github_repo_canonical_lower_idx").on(sql`lower(${t.canonical})`),
    index("github_repo_added_at_idx").on(t.addedAt),
  ],
);

/**
 * Append-only history (FR-REVIEW-06): settings changes now, review steps in stage 3. UPDATE and
 * DELETE are rejected by the `review_event_append_only` trigger (see the migration).
 */
export const reviewEvent = pgTable(
  "review_event",
  {
    id: text("id").primaryKey(),
    type: text("type").$type<ReviewEventType>().notNull(),
    actorKind: text("actor_kind").$type<"user" | "machine" | "system">().notNull(),
    actorId: text("actor_id").notNull(),
    prUrl: text("pr_url"),
    reviewId: text("review_id"),
    jobId: text("job_id"),
    sha: text("sha"),
    reason: text("reason"),
    source: text("source").$type<"web" | "slack" | "system">(),
    detail: jsonb("detail").$type<EventDetail>(),
    at: tstz("at").notNull(),
  },
  (t) => [
    index("review_event_at_idx").on(t.at),
    index("review_event_pr_url_at_idx").on(t.prUrl, t.at),
    // coalesce: a step without a PR URL is still deduplicated per job.
    uniqueIndex("review_event_step_idx")
      .on(t.jobId, sql`coalesce(${t.prUrl}, '')`, t.type)
      .where(sql`${t.jobId} IS NOT NULL`),
  ],
);

// better-auth tables. Shape generated by `auth generate` (1.7.15), with two deliberate changes:
// timestamps are timestamptz (project convention) and the generated RQB v1 `relations()` are
// dropped: drizzle 1.0 removed them, and the adapter only needs `db.query` relations for
// experimental joins, which are not enabled.
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: tstz("created_at").defaultNow().notNull(),
  updatedAt: tstz("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: tstz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tstz("access_token_expires_at"),
    refreshTokenExpiresAt: tstz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const schema = {
  reviewJob,
  reviewJobRead,
  readCursor,
  digestMessage,
  digest,
  digestRead,
  appState,
  githubCredential,
  githubRepo,
  reviewEvent,
  reviewResult,
  slackReviewThread,
  slackReaction,
  reactionOutbox,
  settingSecret,
  settingValue,
  slackReviewChannel,
  loginToken,
  user,
  session,
  account,
  verification,
};
