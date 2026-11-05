import { and, asc, eq, inArray, lt, lte, max, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ok, type Result } from "../../domain/shared/result";
import { isStaleOp, type ReactionEmoji } from "../../domain/slack/status-emoji";
import {
  planConvergence,
  reactionBackoffMs,
  validateClaim,
  validateReactionTarget,
  type EnqueueOutcome,
  type MarkFailedOutcome,
  type OutboxOp,
  type ReactionOutbox,
  type ReactionRetryPolicy,
  type ReactionTarget,
} from "../../ports/reaction-outbox";
import type { Clock } from "../../ports/system";
import type { Db } from "./client";
import { reactionOutbox, slackReaction } from "./pg-reaction-outbox-schema";

type Row = typeof reactionOutbox.$inferSelect;
/** A transaction handle (or the root `Db` inside `db.transaction`). */
type Tx = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

const UNFINISHED = ["pending", "running"] as const;

const toOp = (r: Row): OutboxOp => ({
  id: r.id,
  channel: r.channel,
  ts: r.ts,
  prUrl: r.prUrl,
  reviewId: r.reviewId,
  seq: r.seq,
  op: r.op,
  emoji: r.emoji,
  state: r.state,
  attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt,
  leaseOwner: r.leaseOwner,
  leaseUntil: r.leaseUntil,
  createdAt: r.createdAt,
});

/**
 * Serialises everything that reads or changes one message's reaction state, for the rest of the
 * transaction. The key is a bound parameter; the namespace keeps it apart from other users of
 * advisory locks.
 */
async function lockMessage(tx: Tx, channel: string, ts: string): Promise<void> {
  const k = `reaction_outbox:${channel}:${ts}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`);
}

/**
 * The enqueue step, for a caller's own transaction (architecture §4: the outbox rows commit with
 * the verdict). `tx` MUST be a transaction: the message lock lasts until it ends.
 */
export async function enqueueReactionTarget(
  tx: Tx,
  target: ReactionTarget,
  now: Date,
): Promise<Result<EnqueueOutcome>> {
  const valid = validateReactionTarget(target);
  if (!valid.ok) return valid;
  const { channel, ts, prUrl, state } = target;
  const message = and(eq(reactionOutbox.channel, channel), eq(reactionOutbox.ts, ts));
  await lockMessage(tx, channel, ts);

  const [latest] = await tx
    .select({ seq: max(reactionOutbox.seq) })
    .from(reactionOutbox)
    .where(message);
  const latestSeq = latest?.seq ?? null;
  if (latestSeq !== null && state.seq < latestSeq) return ok({ status: "stale", latestSeq });
  if (latestSeq !== null && state.seq === latestSeq) return ok({ status: "duplicate", latestSeq });

  // `seq < state.seq` is `isStaleOp(op, state.seq)`; every pending op of the message qualifies,
  // because no op has a seq above the latest. Asserted below so the two cannot drift.
  const superseded = await tx
    .update(reactionOutbox)
    .set({ state: "superseded" })
    .where(and(message, eq(reactionOutbox.state, "pending"), lt(reactionOutbox.seq, state.seq)))
    .returning({ seq: reactionOutbox.seq });
  if (!superseded.every((o) => isStaleOp(o, state.seq))) throw new Error("supersede drifted");

  const placedRows = await tx
    .select({ emoji: slackReaction.emoji })
    .from(slackReaction)
    .where(
      and(
        eq(slackReaction.channel, channel),
        eq(slackReaction.ts, ts),
        eq(slackReaction.state, "placed"),
      ),
    );
  const inFlight = await tx
    .select({ op: reactionOutbox.op, emoji: reactionOutbox.emoji })
    .from(reactionOutbox)
    .where(and(message, eq(reactionOutbox.state, "running")))
    .orderBy(asc(reactionOutbox.id));
  const planned = planConvergence(
    placedRows.map((r) => r.emoji),
    inFlight,
    state,
  );
  if (planned.length === 0)
    return ok({ status: "enqueued", ops: [], superseded: superseded.length });

  // One multi-row INSERT: identity values follow VALUES order, so `id` keeps the plan's order.
  const rows = await tx
    .insert(reactionOutbox)
    .values(
      planned.map((p) => ({
        channel,
        ts,
        prUrl,
        reviewId: state.reviewId,
        seq: state.seq,
        op: p.action,
        emoji: p.emoji,
        state: "pending" as const,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })),
    )
    .returning();
  const ops = rows.map(toOp).toSorted((a, b) => a.id - b.id);
  return ok({ status: "enqueued", ops, superseded: superseded.length });
}

export class PgReactionOutbox implements ReactionOutbox {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly policy: ReactionRetryPolicy,
  ) {}

  async enqueue(target: ReactionTarget): Promise<Result<EnqueueOutcome>> {
    const valid = validateReactionTarget(target);
    if (!valid.ok) return valid;
    const now = this.clock.now();
    return this.db.transaction((tx) => enqueueReactionTarget(tx as unknown as Tx, target, now));
  }

  /**
   * One statement. The candidate must be its message's oldest unfinished op (`NOT EXISTS` an
   * older pending/running one), so ops apply in order and at most one per message is in flight.
   * `FOR UPDATE SKIP LOCKED` lets concurrent drainers take different rows without blocking.
   */
  async claimDue(opts: { owner: string; leaseMs: number; limit: number }): Promise<OutboxOp[]> {
    validateClaim(opts);
    const now = this.clock.now();
    const c = alias(reactionOutbox, "c");
    const p = alias(reactionOutbox, "p");
    const olderUnfinished = this.db
      .select({ one: sql`1` })
      .from(p)
      .where(
        and(
          eq(p.channel, c.channel),
          eq(p.ts, c.ts),
          lt(p.id, c.id),
          inArray(p.state, [...UNFINISHED]),
        ),
      );
    const pick = this.db
      .select({ id: c.id })
      .from(c)
      .where(
        and(
          or(
            and(eq(c.state, "pending"), lte(c.nextAttemptAt, now)),
            and(eq(c.state, "running"), lt(c.leaseUntil, now)),
          ),
          notExists(olderUnfinished),
        ),
      )
      .orderBy(asc(c.id))
      .limit(opts.limit)
      .for("update", { skipLocked: true });
    const rows = await this.db
      .update(reactionOutbox)
      .set({
        state: "running",
        leaseOwner: opts.owner,
        leaseUntil: new Date(now.getTime() + opts.leaseMs),
        attempts: sql`${reactionOutbox.attempts} + 1`,
      })
      .where(inArray(reactionOutbox.id, pick))
      .returning();
    return rows.map(toOp).toSorted((a, b) => a.id - b.id);
  }

  private held(id: number, owner: string, now: Date) {
    return and(
      eq(reactionOutbox.id, id),
      eq(reactionOutbox.state, "running"),
      eq(reactionOutbox.leaseOwner, owner),
      sql`${reactionOutbox.leaseUntil} >= ${now}`,
    );
  }

  async markDone(id: number, owner: string): Promise<boolean> {
    if (!Number.isSafeInteger(id) || typeof owner !== "string") return false;
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(reactionOutbox)
        .set({ state: "done", leaseOwner: null, leaseUntil: null })
        .where(this.held(id, owner, now))
        .returning();
      if (!row) return false;
      // Under the message lock, so an enqueue never sees the op done without its reaction.
      await lockMessage(tx as unknown as Tx, row.channel, row.ts);
      const state = row.op === "add" ? ("placed" as const) : ("removed" as const);
      await tx
        .insert(slackReaction)
        .values({
          channel: row.channel,
          ts: row.ts,
          emoji: row.emoji,
          state,
          prUrl: row.prUrl,
          reviewId: row.reviewId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [slackReaction.channel, slackReaction.ts, slackReaction.emoji],
          set: { state, prUrl: row.prUrl, reviewId: row.reviewId, updatedAt: now },
        });
      return true;
    });
  }

  async markFailed(
    id: number,
    owner: string,
    opts: { retryAfterMs?: number; permanent?: boolean } = {},
  ): Promise<MarkFailedOutcome | null> {
    if (!Number.isSafeInteger(id) || typeof owner !== "string") return null;
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ attempts: reactionOutbox.attempts })
        .from(reactionOutbox)
        .where(this.held(id, owner, now))
        .for("update");
      if (!row) return null;
      if (opts.permanent || row.attempts >= this.policy.maxAttempts) {
        await tx
          .update(reactionOutbox)
          .set({ state: "failed", leaseOwner: null, leaseUntil: null })
          .where(eq(reactionOutbox.id, id));
        return { state: "failed" as const };
      }
      const nextAttemptAt = new Date(
        now.getTime() + reactionBackoffMs(row.attempts, this.policy, opts.retryAfterMs),
      );
      await tx
        .update(reactionOutbox)
        .set({ state: "pending", leaseOwner: null, leaseUntil: null, nextAttemptAt })
        .where(eq(reactionOutbox.id, id));
      return { state: "pending" as const, nextAttemptAt };
    });
  }

  async currentReactions(channel: string, ts: string): Promise<ReactionEmoji[]> {
    const rows = await this.db
      .select({ emoji: slackReaction.emoji })
      .from(slackReaction)
      .where(
        and(
          eq(slackReaction.channel, channel),
          eq(slackReaction.ts, ts),
          eq(slackReaction.state, "placed"),
        ),
      );
    // Sorted in JS: the database collation may order `_` differently.
    return rows.map((r) => r.emoji).toSorted();
  }

  async listForMessage(channel: string, ts: string): Promise<OutboxOp[]> {
    const rows = await this.db
      .select()
      .from(reactionOutbox)
      .where(and(eq(reactionOutbox.channel, channel), eq(reactionOutbox.ts, ts)))
      .orderBy(asc(reactionOutbox.id));
    return rows.map(toOp);
  }

  async deleteFinishedBefore(date: Date): Promise<number> {
    const m = alias(reactionOutbox, "m");
    const latestSeq = this.db
      .select({ seq: max(m.seq) })
      .from(m)
      .where(and(eq(m.channel, reactionOutbox.channel), eq(m.ts, reactionOutbox.ts)));
    const rows = await this.db
      .delete(reactionOutbox)
      .where(
        and(
          inArray(reactionOutbox.state, ["done", "failed", "superseded"]),
          lt(reactionOutbox.createdAt, date),
          lt(reactionOutbox.seq, latestSeq),
        ),
      )
      .returning({ id: reactionOutbox.id });
    return rows.length;
  }
}
