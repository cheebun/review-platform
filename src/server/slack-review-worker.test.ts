import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_JOB_WAKE_CHANNEL } from "../application/review/ports";
import { SLACK_SETTINGS_CHANGED_CHANNEL } from "../application/slack/credentials";
import { APP_TOKEN, SLACK_NOW } from "../application/settings/slack-testing";
import { aNewReviewJob } from "../testing/builders/review-job";
import { createTestContainer } from "../testing/container";
import { FakeClock } from "../testing/fakes/fake-clock";
import { MemoryLogger } from "../testing/fakes/memory-logger";
import type { Ports } from "./container";
import { slackServicesFor } from "./slack-features";
import { startSlackReviewWorker, type SlackReviewWorker } from "./slack-review-worker";

async function until(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const saveAppToken = (ports: Ports) =>
  ports.settingsStore.saveSecret(
    "slack_app_token",
    {
      value: APP_TOKEN,
      savedAt: ports.clock.now(),
      savedByUserId: "u1",
      verifiedAt: ports.clock.now(),
      testResult: null,
    },
    () => ({
      id: "evt-app-token",
      type: "slack_secret_saved",
      actor: { kind: "user", id: "u1" },
      at: ports.clock.now(),
      source: "web",
      detail: { kind: "slack_app_token", last4: APP_TOKEN.slice(-4), replaced: false },
    }),
  );

function setup() {
  const clock = new FakeClock(SLACK_NOW);
  const logger = new MemoryLogger();
  const { ports } = createTestContainer({ clock, logger });
  const services = slackServicesFor(ports, { appUrl: "https://ops.test" });
  if (!services) throw new Error("slack review ports not wired in the test container");
  return { ports, services, logger, clock };
}

let worker: SlackReviewWorker | undefined;
afterEach(async () => {
  await worker?.stop({ graceMs: 100 });
  worker = undefined;
});

describe("startSlackReviewWorker without Socket Mode (Events API only)", () => {
  it("runs the review consumer and the outbox drainer with no app token", async () => {
    const s = setup();
    const started: string[] = [];
    worker = await startSlackReviewWorker({
      ...s,
      owner: "test-worker",
      onStarted: (name) => started.push(name),
    });
    const created = await s.ports.reviewJobs.create(aNewReviewJob({ id: "job-1" }));
    expect(created.ok).toBe(true);
    await s.ports.wakeUp.notify(REVIEW_JOB_WAKE_CHANNEL);
    // The consumer claims the queued job although Socket Mode is not configured.
    await until(async () => ((await s.ports.reviewJobs.get("job-1"))?.attempts ?? 0) > 0);
    expect(started.toSorted()).toEqual(["reaction-outbox-drainer", "review-job-consumer"]);
  });

  it("reclaims a job whose lease expired on its own, with no drain endpoint", async () => {
    const s = setup();
    expect((await s.ports.reviewJobs.create(aNewReviewJob({ id: "job-1" }))).ok).toBe(true);
    const crashed = await s.ports.reviewJobs.claimNext({ owner: "crashed-worker", leaseMs: 1_000 });
    expect(crashed?.leaseOwner).toBe("crashed-worker");
    s.clock.advance(1_001);
    worker = await startSlackReviewWorker({ ...s, owner: "test-worker" });
    await s.ports.wakeUp.notify(REVIEW_JOB_WAKE_CHANNEL);
    await until(async () => {
      const job = await s.ports.reviewJobs.get("job-1");
      return job !== null && job.leaseOwner !== "crashed-worker";
    });
    expect((await s.ports.reviewJobs.get("job-1"))?.interruptions).toBe(1);
  });

  it("ignores historical app tokens and stops both work loops idempotently", async () => {
    const s = setup();
    await saveAppToken(s.ports);
    const reads = vi.spyOn(s.ports.settingsStore, "getSecret");
    worker = await startSlackReviewWorker({ ...s, owner: "test-worker" });
    await s.ports.wakeUp.notify(SLACK_SETTINGS_CHANGED_CHANNEL);
    const first = worker.stop({ graceMs: 100 });
    expect(worker.stop({ graceMs: 100 })).toBe(first);
    expect(await first).toEqual({ consumerDrained: true, outboxDrained: true });
    expect(s.logger.entries.some((e) => e.msg.includes("socket mode"))).toBe(false);
    expect(reads).not.toHaveBeenCalledWith("slack_app_token");
    reads.mockRestore();
  });
});
