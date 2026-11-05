import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ReactionEmoji } from "../../domain/slack/status-emoji";
import type { ReactionOpKind, ReactionOpState } from "../../ports/reaction-outbox";

// Owned by 3d; 3w adds `slackReaction` and `reactionOutbox` to `schema` in schema.ts and
// generates the migration.

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** The reactions the app placed per message, so it only ever removes its own (FR-SLACK-14 b). */
export const slackReaction = pgTable(
  "slack_reaction",
  {
    channel: text("channel").notNull(),
    ts: text("ts").notNull(),
    emoji: text("emoji").$type<ReactionEmoji>().notNull(),
    state: text("state").$type<"placed" | "removed">().notNull(),
    prUrl: text("pr_url").notNull(),
    reviewId: text("review_id"),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channel, t.ts, t.emoji] }),
    check("slack_reaction_state_check", sql`${t.state} IN ('placed', 'removed')`),
  ],
);

/** Durable reaction writes (FR-SLACK-08, FR-SHIP-08). Ops of one message apply in `id` order. */
export const reactionOutbox = pgTable(
  "reaction_outbox",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    channel: text("channel").notNull(),
    ts: text("ts").notNull(),
    prUrl: text("pr_url").notNull(),
    reviewId: text("review_id"),
    seq: integer("seq").notNull(),
    op: text("op").$type<ReactionOpKind>().notNull(),
    emoji: text("emoji").$type<ReactionEmoji>().notNull(),
    state: text("state").$type<ReactionOpState>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: tstz("lease_until"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    index("reaction_outbox_message_idx").on(t.channel, t.ts, t.id),
    index("reaction_outbox_due_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.state} IN ('pending', 'running')`),
    check("reaction_outbox_op_check", sql`${t.op} IN ('add', 'remove')`),
    check(
      "reaction_outbox_state_check",
      sql`${t.state} IN ('pending', 'running', 'done', 'failed', 'superseded')`,
    ),
    check("reaction_outbox_seq_check", sql`${t.seq} >= 0`),
  ],
);
