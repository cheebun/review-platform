/**
 * Reaction outbox drain (FR-SLACK-08, FR-SLACK-14): applies queued status-emoji ops to Slack.
 *
 * Per round it leases the due ops (the outbox hands out at most one per message, the oldest
 * unfinished, so each message's ops apply in order) and applies them concurrently across
 * messages. Retry-After and backoff are the outbox's (`markFailed`). This module only ever
 * touches the outbox and Slack reactions: it can never change a review result.
 */
import type { DomainError } from "../../domain/shared/result";
import { isValidReactionSet } from "../../domain/slack/status-emoji";
import type { OutboxOp, ReactionOutbox } from "../../ports/reaction-outbox";
import type { Logger } from "../../ports/system";
import type { ReactionSender, Timers } from "./ports";
import { withDeadline } from "./resilience";

export type ReactionDrainConfig = {
  /** Lease per claimed op; longer than `callTimeoutMs` so a slow call cannot outlive it. */
  leaseMs: number;
  callTimeoutMs: number;
  /** Ops claimed per round (one per message). */
  batch: number;
  /** Rounds per drain call, so one call is bounded even with a long backlog. */
  maxRounds: number;
};

export const DEFAULT_REACTION_DRAIN_CONFIG: ReactionDrainConfig = {
  leaseMs: 60_000,
  callTimeoutMs: 15_000,
  batch: 20,
  maxRounds: 10,
};

export type ReactionDrainDeps = {
  outbox: ReactionOutbox;
  sender: ReactionSender;
  timers: Timers;
  logger: Logger;
  config?: Partial<ReactionDrainConfig>;
};

export type DrainReport = {
  rounds: number;
  applied: number;
  retried: number;
  failed: number;
  /** Ops whose lease another drainer took over before the result was recorded. */
  lost: number;
};

type OpOutcome = "applied" | "retried" | "failed" | "lost";

/** Permanent: retrying cannot help (message gone, no permission, bad input). */
const isPermanent = (e: DomainError): boolean =>
  e.kind === "not_found" || e.kind === "forbidden" || e.kind === "validation";

export async function drainReactionOutbox(
  deps: ReactionDrainDeps,
  owner: string,
): Promise<DrainReport> {
  const cfg = { ...DEFAULT_REACTION_DRAIN_CONFIG, ...deps.config };
  const report: DrainReport = { rounds: 0, applied: 0, retried: 0, failed: 0, lost: 0 };
  for (let round = 0; round < cfg.maxRounds; round++) {
    let due: OutboxOp[];
    try {
      due = await deps.outbox.claimDue({ owner, leaseMs: cfg.leaseMs, limit: cfg.batch });
    } catch (error) {
      deps.logger.error("reaction outbox unavailable", { error: describe(error) });
      break;
    }
    if (due.length === 0) break;
    report.rounds += 1;
    const outcomes = await Promise.all(due.map((op) => applyOp(deps, cfg, owner, op)));
    for (const o of outcomes) report[o] += 1;
    // Everything that was due is waiting on backoff now: stop rather than spin.
    if (outcomes.every((o) => o !== "applied")) break;
  }
  return report;
}

async function applyOp(
  deps: ReactionDrainDeps,
  cfg: ReactionDrainConfig,
  owner: string,
  op: OutboxOp,
): Promise<OpOutcome> {
  const where = { channel: op.channel, ts: op.ts, emoji: op.emoji, op: op.op, id: op.id };
  try {
    if (op.op === "add") {
      // Fail closed: an add that would leave two status emoji (or ✅ alone) is never sent.
      const current = await deps.outbox.currentReactions(op.channel, op.ts);
      if (!isValidReactionSet([...current, op.emoji])) {
        deps.logger.error("reaction add would break the status invariant", { ...where, current });
        return finish(await deps.outbox.markFailed(op.id, owner, { permanent: true }), "failed");
      }
    }
    const input = { channel: op.channel, ts: op.ts, emoji: op.emoji };
    const sent = await withDeadline(deps.timers, cfg.callTimeoutMs, "slack", () =>
      op.op === "add" ? deps.sender.add(input) : deps.sender.remove(input),
    );
    if (sent.ok) {
      return (await deps.outbox.markDone(op.id, owner)) ? "applied" : lost(deps, where);
    }
    const e = sent.error;
    const permanent = isPermanent(e);
    deps.logger.warn("reaction op failed", { ...where, error: e.kind, permanent });
    const marked = await deps.outbox.markFailed(op.id, owner, {
      ...(e.kind === "rate_limited" ? { retryAfterMs: e.retryAfterMs } : {}),
      ...(permanent ? { permanent: true } : {}),
    });
    if (!marked) return lost(deps, where);
    return marked.state === "failed" ? "failed" : "retried";
  } catch (error) {
    // A store error: the lease runs out and the op is reclaimed later.
    deps.logger.error("reaction op not recorded", { ...where, error: describe(error) });
    return "lost";
  }
}

function finish(marked: unknown, outcome: OpOutcome): OpOutcome {
  return marked ? outcome : "lost";
}

function lost(deps: ReactionDrainDeps, where: Record<string, unknown>): OpOutcome {
  deps.logger.warn("reaction op lease lost", where);
  return "lost";
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
