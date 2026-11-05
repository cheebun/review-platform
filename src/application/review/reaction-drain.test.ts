import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHANGES,
  FORCE_APPROVED,
  isValidReactionSet,
  MERGED,
  PASSED,
  PENDING,
} from "../../domain/slack/status-emoji";
import type { DomainError } from "../../domain/shared/result";
import { DEFAULT_REACTION_RETRY } from "../../ports/reaction-outbox";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { InMemoryReactionOutbox } from "../../testing/fakes/in-memory-reaction-outbox";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { T0 } from "./harness.test-support";
import { drainReactionOutbox } from "./reaction-drain";
import {
  acceptedTarget,
  forceApprovedTarget,
  mergedTarget,
  verdictTarget,
} from "./reaction-target";
import { FakeReactionSender, FakeTimers } from "./testing";

const MSG = { channel: "C0REVIEW", ts: "1700000000.000100" };
const PR = "https://github.com/acme/app/pull/1";
const m = (round: number) => ({ ...MSG, prUrl: PR, round, reviewId: `r${round}` });

function setup() {
  const clock = new FakeClock(T0);
  const outbox = new InMemoryReactionOutbox(clock, { ...DEFAULT_REACTION_RETRY, jitter: () => 0 });
  const sender = new FakeReactionSender();
  const timers = new FakeTimers();
  const logger = new MemoryLogger();
  const deps = { outbox, sender, timers, logger };
  return { clock, outbox, sender, timers, logger, deps };
}

describe("drainReactionOutbox", () => {
  it("does nothing when nothing is due", async () => {
    const s = setup();
    expect(await drainReactionOutbox(s.deps, "d")).toEqual({
      rounds: 0,
      applied: 0,
      retried: 0,
      failed: 0,
      lost: 0,
    });
  });

  it("applies a message's ops in order: ⏳ then remove ⏳, add 🟢", async () => {
    const s = setup();
    await s.outbox.enqueue(acceptedTarget(m(1)));
    await drainReactionOutbox(s.deps, "d");
    await s.outbox.enqueue(verdictTarget({ ...m(1), outcomes: ["pass"] }));
    const report = await drainReactionOutbox(s.deps, "d");
    expect(report.applied).toBe(2);
    expect(s.sender.calls.map((c) => `${c.op}:${c.emoji}`)).toEqual([
      `add:${PENDING}`,
      `remove:${PENDING}`,
      `add:${PASSED}`,
    ]);
    expect(s.sender.reactions(MSG)).toEqual([PASSED]);
    expect(await s.outbox.currentReactions(MSG.channel, MSG.ts)).toEqual([PASSED]);
  });

  it("applies different messages in the same round", async () => {
    const s = setup();
    await s.outbox.enqueue(acceptedTarget(m(1)));
    await s.outbox.enqueue(acceptedTarget({ ...m(1), ts: "1700000000.000200" }));
    const report = await drainReactionOutbox(s.deps, "d");
    expect(report).toMatchObject({ rounds: 1, applied: 2 });
  });

  it("honours Retry-After: a 429 is retried no earlier than Slack asked", async () => {
    const s = setup();
    await s.outbox.enqueue(acceptedTarget(m(1)));
    s.sender.failNext({ kind: "rate_limited", retryAfterMs: 120_000 });
    expect(await drainReactionOutbox(s.deps, "d")).toMatchObject({ retried: 1, applied: 0 });
    const [op] = await s.outbox.listForMessage(MSG.channel, MSG.ts);
    expect(op!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(T0.getTime() + 120_000);

    s.clock.advance(60_000);
    expect(await drainReactionOutbox(s.deps, "d")).toMatchObject({ rounds: 0 });
    s.clock.advance(60_001);
    expect(await drainReactionOutbox(s.deps, "d")).toMatchObject({ applied: 1 });
    expect(s.sender.reactions(MSG)).toEqual([PENDING]);
  });

  it("a transient failure backs off; after the last attempt the op is failed", async () => {
    const s = setup();
    await s.outbox.enqueue(acceptedTarget(m(1)));
    const fault: DomainError = { kind: "upstream", service: "slack", retryable: true };
    s.sender.failNext(fault, 100);
    for (let i = 0; i < DEFAULT_REACTION_RETRY.maxAttempts; i++) {
      await drainReactionOutbox(s.deps, "d");
      s.clock.advance(DEFAULT_REACTION_RETRY.maxMs * 2);
    }
    const [op] = await s.outbox.listForMessage(MSG.channel, MSG.ts);
    expect(op!.state).toBe("failed");
    expect(op!.attempts).toBe(DEFAULT_REACTION_RETRY.maxAttempts);
  });

  it("a deleted message fails the op at once", async () => {
    const s = setup();
    await s.outbox.enqueue(acceptedTarget(m(1)));
    s.sender.failNext({ kind: "not_found", entity: "message" });
    expect(await drainReactionOutbox(s.deps, "d")).toMatchObject({ failed: 1 });
    expect((await s.outbox.listForMessage(MSG.channel, MSG.ts))[0]!.state).toBe("failed");
  });

  it("a Slack call past its deadline is retried later, and the timer is released", async () => {
    const s = setup();
    s.timers.fireDeadlines = true;
    s.sender.add = () => new Promise(() => {});
    await s.outbox.enqueue(acceptedTarget(m(1)));
    expect(await drainReactionOutbox(s.deps, "d")).toMatchObject({ retried: 1 });
    expect(s.timers.cancelled).toBe(1);
  });

  it("a throwing sender does not crash the drain", async () => {
    const s = setup();
    s.sender.add = async () => {
      throw new Error("socket closed");
    };
    await s.outbox.enqueue(acceptedTarget(m(1)));
    expect(await drainReactionOutbox(s.deps, "d")).toMatchObject({ retried: 1 });
  });

  it("a store failure ends the drain quietly", async () => {
    const s = setup();
    s.outbox.claimDue = async () => {
      throw new Error("db down");
    };
    expect(await drainReactionOutbox(s.deps, "d")).toMatchObject({ rounds: 0 });
    expect(s.logger.entries.some((e) => e.level === "error")).toBe(true);
  });

  it("never adds a second status emoji, even when an earlier remove failed for good", async () => {
    const s = setup();
    await s.outbox.enqueue(verdictTarget({ ...m(1), outcomes: ["changes_requested"] }));
    await drainReactionOutbox(s.deps, "d");
    await s.outbox.enqueue(forceApprovedTarget(m(1)));
    s.sender.failNext({ kind: "forbidden", reason: "missing scope" }); // the remove of 🔴
    await drainReactionOutbox(s.deps, "d");
    expect(s.sender.reactions(MSG)).toEqual([CHANGES]);
    expect(s.sender.calls.filter((c) => c.op === "add" && c.emoji === FORCE_APPROVED)).toEqual([]);
  });

  it("property: after any interleaving of transitions, faults and drains, at most one status emoji", async () => {
    const step = fc.oneof(
      fc.record({ kind: fc.constant("accepted" as const), round: fc.integer({ min: 1, max: 3 }) }),
      fc.record({
        kind: fc.constant("verdict" as const),
        round: fc.integer({ min: 1, max: 3 }),
        pass: fc.boolean(),
      }),
      fc.record({ kind: fc.constant("force" as const), round: fc.integer({ min: 1, max: 3 }) }),
      fc.record({
        kind: fc.constant("merged" as const),
        round: fc.integer({ min: 1, max: 3 }),
        forced: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant("fault" as const),
        error: fc.constantFrom<DomainError>(
          { kind: "rate_limited", retryAfterMs: 1_000 },
          { kind: "upstream", service: "slack", retryable: true },
          { kind: "not_found", entity: "message" },
        ),
      }),
      fc.record({
        kind: fc.constant("drain" as const),
        advanceMs: fc.integer({ min: 0, max: 3_600_000 }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 25 }), async (steps) => {
        const s = setup();
        const check = () => expect(isValidReactionSet(s.sender.reactions(MSG))).toBe(true);
        for (const st of steps) {
          if (st.kind === "accepted") await s.outbox.enqueue(acceptedTarget(m(st.round)));
          if (st.kind === "verdict")
            await s.outbox.enqueue(
              verdictTarget({ ...m(st.round), outcomes: [st.pass ? "pass" : "changes_requested"] }),
            );
          if (st.kind === "force") await s.outbox.enqueue(forceApprovedTarget(m(st.round)));
          if (st.kind === "merged")
            await s.outbox.enqueue(
              mergedTarget({ ...m(st.round), status: st.forced ? FORCE_APPROVED : PASSED }),
            );
          if (st.kind === "fault") s.sender.failNext(st.error);
          if (st.kind === "drain") {
            s.clock.advance(st.advanceMs);
            await drainReactionOutbox(s.deps, "d");
          }
          check();
        }
        s.clock.advance(24 * 3_600_000);
        await drainReactionOutbox(s.deps, "d");
        check();
        const reactions = s.sender.reactions(MSG);
        if (reactions.includes(MERGED))
          expect(reactions.includes(PASSED) || reactions.includes(FORCE_APPROVED)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
