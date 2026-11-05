import { describe, expect, it } from "vitest";
import { harness } from "../../application/review/harness.test-support";
import { REVIEW_JOB_WAKE_CHANNEL } from "../../application/review/ports";
import { acceptedTarget } from "../../application/review/reaction-target";
import { processNextReviewJob } from "../../application/review/review-job-consumer";
import { FakeReactionSender } from "../../application/review/testing";
import { PENDING } from "../../domain/slack/status-emoji";
import { InMemoryWakeUp } from "../../testing/fakes/in-memory-wake-up";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { startPollingWorker, type TickResult } from "./polling-worker";
import { startReactionOutboxDrainer } from "./reaction-outbox-drainer";
import { startReviewJobConsumer } from "./review-job-consumer";
import { realTimers } from "./timers";

const HOUR = 3_600_000;

async function until(cond: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("startPollingWorker", () => {
  it("is woken by a WakeUp notification long before the poll interval", async () => {
    const logger = new MemoryLogger();
    const wakeUp = new InMemoryWakeUp({ now: () => new Date() });
    let ticks = 0;
    const worker = await startPollingWorker({
      name: "t",
      pollMs: HOUR,
      errorBackoffMs: HOUR,
      logger,
      wake: { wakeUp, channel: "c" },
      tick: async () => {
        ticks += 1;
        return "idle";
      },
    });
    await until(() => ticks === 1);
    await wakeUp.notify("c");
    await until(() => ticks === 2);
    expect(await worker.stop({ graceMs: 1_000 })).toEqual({ drained: true });
  });

  it("runs back to back while busy, then waits", async () => {
    const results: TickResult[] = ["busy", "busy", "idle"];
    let ticks = 0;
    const worker = await startPollingWorker({
      name: "t",
      pollMs: HOUR,
      errorBackoffMs: HOUR,
      logger: new MemoryLogger(),
      tick: async () => results[Math.min(ticks++, results.length - 1)]!,
    });
    await until(() => ticks === 3);
    await new Promise((r) => setTimeout(r, 20));
    expect(ticks).toBe(3);
    await worker.stop();
  });

  it("a throwing tick is logged and the loop keeps going", async () => {
    const logger = new MemoryLogger();
    let ticks = 0;
    const worker = await startPollingWorker({
      name: "t",
      pollMs: 1,
      errorBackoffMs: 1,
      logger,
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error("db down");
        return "idle";
      },
    });
    await until(() => ticks >= 3);
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
    await worker.stop();
  });

  it("stop waits for the tick in flight, then no further tick starts", async () => {
    let release!: () => void;
    let ticks = 0;
    const worker = await startPollingWorker({
      name: "t",
      pollMs: 1,
      errorBackoffMs: 1,
      logger: new MemoryLogger(),
      tick: () => {
        ticks += 1;
        return new Promise<TickResult>((r) => (release = () => r("busy")));
      },
    });
    await until(() => ticks === 1);
    const stopping = worker.stop({ graceMs: 1_000 });
    release();
    expect(await stopping).toEqual({ drained: true });
    expect(ticks).toBe(1);
    expect(await worker.stop()).toEqual({ drained: true });
  });

  it("stop gives up after the grace period without hanging", async () => {
    const logger = new MemoryLogger();
    let started = false;
    const worker = await startPollingWorker({
      name: "t",
      pollMs: 1,
      errorBackoffMs: 1,
      logger,
      tick: () => {
        started = true;
        return new Promise<TickResult>(() => {});
      },
    });
    await until(() => started);
    expect(await worker.stop({ graceMs: 10 })).toEqual({ drained: false });
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("a failing subscribe falls back to polling", async () => {
    const logger = new MemoryLogger();
    let ticks = 0;
    const worker = await startPollingWorker({
      name: "t",
      pollMs: 1,
      errorBackoffMs: 1,
      logger,
      wake: {
        wakeUp: {
          notify: async () => {},
          subscribe: async () => {
            throw new Error("redis down");
          },
        },
        channel: "c",
      },
      tick: async () => {
        ticks += 1;
        return "idle";
      },
    });
    await until(() => ticks >= 2);
    await worker.stop();
  });
});

describe("startReviewJobConsumer", () => {
  it("processes a job when woken and stops cleanly", async () => {
    const h = harness();
    const wakeUp = new InMemoryWakeUp(h.clock);
    const worker = await startReviewJobConsumer({
      deps: h.deps,
      owner: "w1",
      wakeUp,
      pollMs: HOUR,
    });
    const job = await h.enqueue();
    await wakeUp.notify(REVIEW_JOB_WAKE_CHANNEL);
    await until(async () => (await h.jobs.get(job.id))?.state === "done");
    expect(h.replier.replies).toHaveLength(1);
    expect(await worker.stop({ graceMs: 1_000 })).toEqual({ drained: true });
  });

  it("runs the reply backstop when idle", async () => {
    const h = harness();
    h.deps.replier = null;
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, "w0");
    h.deps.replier = h.replier;
    const worker = await startReviewJobConsumer({ deps: h.deps, owner: "w1", pollMs: HOUR });
    await until(() => h.replier.replies.length === 1);
    expect((await h.jobs.get(job.id))!.resultReplySent).toBe(true);
    await worker.stop();
  });
});

describe("startReactionOutboxDrainer", () => {
  it("drains due ops to Slack", async () => {
    const h = harness();
    const sender = new FakeReactionSender();
    const msg = { channel: "C0REVIEW", ts: "1700000000.000100" };
    await h.outbox.enqueue(
      acceptedTarget({
        ...msg,
        prUrl: "https://github.com/acme/app/pull/1",
        round: 1,
        reviewId: "r",
      }),
    );
    const worker = await startReactionOutboxDrainer({
      deps: { outbox: h.outbox, sender, timers: realTimers, logger: h.logger },
      owner: "d1",
      pollMs: HOUR,
    });
    await until(() => sender.reactions(msg).length === 1);
    expect(sender.reactions(msg)).toEqual([PENDING]);
    await worker.stop();
  });
});

describe("realTimers", () => {
  it("sleep resolves and a cancelled deadline never fires", async () => {
    await realTimers.sleep(1);
    const d = realTimers.deadline(5);
    let fired = false;
    void d.done.then(() => (fired = true));
    d.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(false);
  });
});
