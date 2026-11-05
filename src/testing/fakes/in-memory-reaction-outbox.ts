import { isStaleOp, type ReactionEmoji } from "../../domain/slack/status-emoji";
import { ok, type Result } from "../../domain/shared/result";
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

const key = (channel: string, ts: string) => `${channel}\u0000${ts}`;
const UNFINISHED = new Set(["pending", "running"]);

/**
 * In-memory outbox with the PG adapter's semantics. Every method body runs without an await, so
 * each call is atomic, standing in for the per-message lock and `FOR UPDATE SKIP LOCKED`.
 */
export class InMemoryReactionOutbox implements ReactionOutbox {
  private ops: OutboxOp[] = [];
  private nextId = 1;
  /** (channel, ts) → emoji → placed. */
  private readonly reactions = new Map<string, Map<ReactionEmoji, boolean>>();

  constructor(
    private readonly clock: Clock,
    private readonly policy: ReactionRetryPolicy,
  ) {}

  async enqueue(target: ReactionTarget): Promise<Result<EnqueueOutcome>> {
    const valid = validateReactionTarget(target);
    if (!valid.ok) return valid;
    const { channel, ts, prUrl, state } = target;
    const now = this.clock.now();
    const mine = this.ops.filter((o) => o.channel === channel && o.ts === ts);
    if (mine.length > 0) {
      const latestSeq = Math.max(...mine.map((o) => o.seq));
      if (state.seq < latestSeq) return ok({ status: "stale", latestSeq });
      if (state.seq === latestSeq) return ok({ status: "duplicate", latestSeq });
    }
    let superseded = 0;
    for (const o of mine) {
      if (o.state === "pending" && isStaleOp(o, state.seq)) {
        o.state = "superseded";
        superseded++;
      }
    }
    const placed = this.placed(channel, ts);
    const inFlight = mine.filter((o) => o.state === "running");
    const created = planConvergence(placed, inFlight, state).map((p): OutboxOp => ({
      id: this.nextId++,
      channel,
      ts,
      prUrl,
      reviewId: state.reviewId,
      seq: state.seq,
      op: p.action,
      emoji: p.emoji,
      state: "pending",
      attempts: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: now,
    }));
    this.ops.push(...created);
    return ok({ status: "enqueued", ops: created.map((o) => ({ ...o })), superseded });
  }

  async claimDue(opts: { owner: string; leaseMs: number; limit: number }): Promise<OutboxOp[]> {
    validateClaim(opts);
    const now = this.clock.now();
    const heads = new Map<string, OutboxOp>();
    for (const o of this.ops.toSorted((a, b) => a.id - b.id)) {
      const k = key(o.channel, o.ts);
      if (UNFINISHED.has(o.state) && !heads.has(k)) heads.set(k, o);
    }
    const due = [...heads.values()]
      .filter((o) =>
        o.state === "pending"
          ? o.nextAttemptAt.getTime() <= now.getTime()
          : o.leaseUntil!.getTime() < now.getTime(),
      )
      .toSorted((a, b) => a.id - b.id)
      .slice(0, opts.limit);
    for (const o of due) {
      o.state = "running";
      o.leaseOwner = opts.owner;
      o.leaseUntil = new Date(now.getTime() + opts.leaseMs);
      o.attempts += 1;
    }
    return due.map((o) => ({ ...o }));
  }

  private held(id: number, owner: string): OutboxOp | undefined {
    const now = this.clock.now().getTime();
    return this.ops.find(
      (o) =>
        o.id === id &&
        o.state === "running" &&
        o.leaseOwner === owner &&
        o.leaseUntil!.getTime() >= now,
    );
  }

  async markDone(id: number, owner: string): Promise<boolean> {
    const o = this.held(id, owner);
    if (!o) return false;
    o.state = "done";
    o.leaseOwner = null;
    o.leaseUntil = null;
    const k = key(o.channel, o.ts);
    const m = this.reactions.get(k) ?? new Map<ReactionEmoji, boolean>();
    m.set(o.emoji, o.op === "add");
    this.reactions.set(k, m);
    return true;
  }

  async markFailed(
    id: number,
    owner: string,
    opts: { retryAfterMs?: number; permanent?: boolean } = {},
  ): Promise<MarkFailedOutcome | null> {
    const o = this.held(id, owner);
    if (!o) return null;
    o.leaseOwner = null;
    o.leaseUntil = null;
    if (opts.permanent || o.attempts >= this.policy.maxAttempts) {
      o.state = "failed";
      return { state: "failed" };
    }
    o.state = "pending";
    o.nextAttemptAt = new Date(
      this.clock.now().getTime() + reactionBackoffMs(o.attempts, this.policy, opts.retryAfterMs),
    );
    return { state: "pending", nextAttemptAt: new Date(o.nextAttemptAt) };
  }

  private placed(channel: string, ts: string): ReactionEmoji[] {
    const m = this.reactions.get(key(channel, ts));
    return m
      ? [...m]
          .filter(([, on]) => on)
          .map(([e]) => e)
          .toSorted()
      : [];
  }

  async currentReactions(channel: string, ts: string): Promise<ReactionEmoji[]> {
    return this.placed(channel, ts);
  }

  async listForMessage(channel: string, ts: string): Promise<OutboxOp[]> {
    return this.ops
      .filter((o) => o.channel === channel && o.ts === ts)
      .toSorted((a, b) => a.id - b.id)
      .map((o) => ({ ...o }));
  }

  async deleteFinishedBefore(date: Date): Promise<number> {
    const latest = new Map<string, number>();
    for (const o of this.ops) {
      const k = key(o.channel, o.ts);
      latest.set(k, Math.max(latest.get(k) ?? -1, o.seq));
    }
    const before = this.ops.length;
    this.ops = this.ops.filter(
      (o) =>
        UNFINISHED.has(o.state) ||
        o.createdAt.getTime() >= date.getTime() ||
        o.seq === latest.get(key(o.channel, o.ts)),
    );
    return before - this.ops.length;
  }
}
