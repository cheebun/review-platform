import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  RecordFinding,
  RequesterKind,
  ReviewRecordSource,
  ReviewRecordStatus,
  ReviewVerdict,
} from "../../ports/review-record-repo";

// Owned by 3d; 3w adds `reviewResult` to `schema` in schema.ts and generates the migration.
// No schema prefix: isolation comes from `search_path`, as for every other table.

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * The durable review record (FR-REVIEW-05): one row per PR URL per run of a job, kept after the
 * `review_job` row is purged. `(job_id, pr_url, run)` is the idempotency key.
 */
export const reviewResult = pgTable(
  "review_result",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    /** The job's attempt count at the terminal transition: a retried job writes a new record. */
    run: integer("run").notNull(),
    prUrl: text("pr_url").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    headSha: text("head_sha"),
    baseSha: text("base_sha"),
    source: text("source").$type<ReviewRecordSource>().notNull(),
    requesterKind: text("requester_kind").$type<RequesterKind>().notNull(),
    requesterId: text("requester_id").notNull(),
    provider: text("provider"),
    model: text("model"),
    startedAt: tstz("started_at").notNull(),
    finishedAt: tstz("finished_at").notNull(),
    status: text("status").$type<ReviewRecordStatus>().notNull(),
    verdict: text("verdict").$type<ReviewVerdict>(),
    errorCategory: text("error_category"),
    summary: text("summary"),
    findings: jsonb("findings").$type<RecordFinding[]>().notNull(),
  },
  (t) => [
    uniqueIndex("review_result_run_idx").on(t.jobId, t.prUrl, t.run),
    index("review_result_finished_idx").on(t.finishedAt, t.id),
    index("review_result_pr_url_idx").on(t.prUrl, t.finishedAt),
    index("review_result_repo_idx").on(sql`lower(${t.owner})`, sql`lower(${t.repo})`, t.number),
    check("review_result_status_check", sql`${t.status} IN ('completed', 'failed')`),
    check("review_result_source_check", sql`${t.source} IN ('slack', 'web')`),
    check(
      "review_result_verdict_check",
      sql`(${t.status} = 'completed' AND ${t.verdict} IN ('pass', 'changes_requested') AND ${t.errorCategory} IS NULL)
        OR (${t.status} = 'failed' AND ${t.verdict} IS NULL AND ${t.errorCategory} IS NOT NULL)`,
    ),
    check("review_result_run_check", sql`${t.run} >= 1`),
    check("review_result_number_check", sql`${t.number} >= 1`),
    check("review_result_time_check", sql`${t.finishedAt} >= ${t.startedAt}`),
  ],
);
