import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Owned by 3d; 3w adds `slackReviewThread` to `schema` in schema.ts and generates the migration.

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** (channel, thread_ts) → review, for thread commands (FR-SLACK-13, FR-SLACK-14). */
export const slackReviewThread = pgTable(
  "slack_review_thread",
  {
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    prUrls: jsonb("pr_urls").$type<string[]>().notNull(),
    requesterSlackId: text("requester_slack_id").notNull(),
    latestReviewId: text("latest_review_id").notNull(),
    reviewSeq: integer("review_seq").notNull(),
    statusMessageTs: text("status_message_ts"),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channel, t.threadTs] }),
    check("slack_review_thread_seq_check", sql`${t.reviewSeq} >= 1`),
  ],
);
