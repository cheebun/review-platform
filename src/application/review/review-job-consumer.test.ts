import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { err, ok } from "../../domain/shared/result";
import { CHANGES, PASSED, PENDING } from "../../domain/slack/status-emoji";
import {
  blocking,
  CHANNEL,
  harness,
  passing,
  PR1,
  PR2,
  REQUESTER,
  SHA_A,
  SHA_B,
  TS,
} from "./harness.test-support";
import { acceptedTarget } from "./reaction-target";
import {
  processNextReviewJob,
  sendPendingResultReplies,
  DEFAULT_REVIEW_CONSUMER_CONFIG,
} from "./review-job-consumer";

const OWNER = "worker-1";
const ref1 = { owner: "acme", repo: "app", number: 1 };

async function runToEnd(h: ReturnType<typeof harness>, max = 10) {
  const outcomes = [];
  for (let i = 0; i < max; i++) {
    const out = await processNextReviewJob(h.deps, OWNER);
    if (out.kind === "idle") break;
    outcomes.push(out);
  }
  return outcomes;
}

const byState = (h: ReturnType<typeof harness>, state: string) =>
  h.reviews().filter((r) => r.state === state);

describe("processNextReviewJob", () => {
  it("is idle when nothing is due", async () => {
    const h = harness();
    expect(await processNextReviewJob(h.deps, OWNER)).toEqual({ kind: "idle" });
  });

  it("🟢: posts one COMMENT review and one APPROVE at the reviewed SHA, never merges", async () => {
    const h = harness();
    const job = await h.enqueue();
    const out = await processNextReviewJob(h.deps, OWNER);

    expect(out).toEqual({ kind: "processed", jobId: job.id, state: "done" });
    expect(byState(h, "COMMENTED").map((r) => r.commitId)).toEqual([SHA_A]);
    expect(byState(h, "APPROVED").map((r) => r.commitId)).toEqual([SHA_A]);
    expect(h.world.count("merge")).toBe(0);
    // The PR text goes to the reviewer as data; delimiting is the adapter's job.
    expect(h.reviewer.calls[0]).toMatchObject({ owner: "acme", repo: "app", number: 1 });
    expect(h.reviewer.calls[0]!.diffText).toContain("+b");

    const saved = (await h.jobs.get(job.id))!;
    expect(saved.state).toBe("done");
    expect(saved.progress[PR1]!.approve).toMatchObject({ step: "approved", sha: SHA_A });
    expect(saved.resultReplySent).toBe(true);
  });

  it("🟢: one record, its events, the thread index and the 🟢 target commit together", async () => {
    const h = harness();
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);

    const record = (await h.records.latestForPr(PR1))!;
    expect(record).toMatchObject({
      jobId: job.id,
      run: 1,
      status: "completed",
      verdict: "pass",
      headSha: SHA_A,
      source: "slack",
      requester: { kind: "slack", id: REQUESTER },
      provider: "anthropic",
      model: "test-model",
    });
    const events = await h.events.list({ prUrl: PR1, limit: 50 });
    expect(events.map((e) => e.type).toSorted()).toEqual(
      ["approved", "comment_posted", "review_finished"].toSorted(),
    );
    const approved = events.find((e) => e.type === "approved")!;
    expect(approved).toMatchObject({
      actor: { kind: "system" },
      sha: SHA_A,
      reason: "auto: review passed",
      reviewId: record.id,
      jobId: job.id,
    });

    const thread = (await h.threads.get({ channel: CHANNEL, threadTs: TS }))!;
    expect(thread).toMatchObject({ prUrls: [PR1], reviewSeq: 1, latestReviewId: record.id });
    const ops = await h.outbox.listForMessage(CHANNEL, TS);
    expect(ops.map((o) => [o.op, o.emoji, o.seq])).toEqual([["add", PASSED, 5]]);
    expect(h.uow.commits).toBe(1);
  });

  it("🟢 after ⏳: the outbox swaps ⏳ for 🟢, remove first", async () => {
    const h = harness();
    await h.enqueue();
    await h.outbox.enqueue(
      acceptedTarget({ channel: CHANNEL, ts: TS, prUrl: PR1, round: 1, reviewId: "intake" }),
    );
    const [accepted] = await h.outbox.claimDue({ owner: "d", leaseMs: 1000, limit: 5 });
    await h.outbox.markDone(accepted!.id, "d");

    await processNextReviewJob(h.deps, OWNER);
    const ops = (await h.outbox.listForMessage(CHANNEL, TS)).filter((o) => o.state === "pending");
    expect(ops.map((o) => [o.op, o.emoji])).toEqual([
      ["remove", PENDING],
      ["add", PASSED],
    ]);
  });

  it("🔴: REQUEST_CHANGES at the reviewed SHA, no APPROVE, 🔴 target, changes_requested event", async () => {
    const h = harness();
    h.reviewer.answers = [ok(blocking())];
    await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);

    expect(byState(h, "CHANGES_REQUESTED").map((r) => r.commitId)).toEqual([SHA_A]);
    expect(byState(h, "APPROVED")).toEqual([]);
    const events = await h.events.list({ prUrl: PR1, limit: 50 });
    expect(events.map((e) => e.type)).toContain("changes_requested");
    expect(events.map((e) => e.type)).not.toContain("approved");
    const ops = await h.outbox.listForMessage(CHANNEL, TS);
    expect(ops.map((o) => [o.op, o.emoji])).toEqual([["add", CHANGES]]);
    expect(h.replier.replies[0]!.text).toContain("REQUEST_CHANGES");
    expect(h.replier.replies[0]!.text).toContain("P0: Null deref");
  });

  it("head moved between review and approve: 0 APPROVE, skipped, still 🟢 and done", async () => {
    const h = harness();
    h.reviewer.onReview = () => h.world.pushHead(ref1, SHA_B);
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);

    expect(byState(h, "APPROVED")).toEqual([]);
    const saved = (await h.jobs.get(job.id))!;
    expect(saved.state).toBe("done");
    expect(saved.progress[PR1]!.approve).toEqual({
      step: "approve_skipped",
      sha: SHA_A,
      reason: "sha_changed",
    });
    expect((await h.outbox.listForMessage(CHANNEL, TS)).map((o) => o.emoji)).toEqual([PASSED]);
    expect(h.replier.replies[0]!.text).toContain("re-review needed");
  });

  it("own PR: 0 APPROVE, skipped with own_pr", async () => {
    const h = harness();
    h.world.addPr({ ...ref1, headSha: SHA_A, author: h.world.login });
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);
    expect(byState(h, "APPROVED")).toEqual([]);
    expect((await h.jobs.get(job.id))!.progress[PR1]!.approve).toMatchObject({
      step: "approve_skipped",
      reason: "own_pr",
    });
  });

  it("already approved at the SHA on GitHub: no second APPROVE", async () => {
    const h = harness();
    h.world.addReview(ref1, { state: "APPROVED", commitId: SHA_A });
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);
    expect(byState(h, "APPROVED")).toHaveLength(1);
    expect((await h.jobs.get(job.id))!.progress[PR1]!.approve).toMatchObject({
      step: "approve_skipped",
      reason: "already_approved",
    });
  });

  it("APPROVE fails: approve_failed recorded, job still done with 🟢, reply says so", async () => {
    const h = harness();
    h.github.beforeSubmit = (_ref, input) =>
      input.event === "APPROVE"
        ? err({ kind: "upstream", service: "github", retryable: false })
        : undefined;
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);

    const saved = (await h.jobs.get(job.id))!;
    expect(saved.state).toBe("done");
    expect(saved.progress[PR1]!.approve).toMatchObject({ step: "approve_failed", sha: SHA_A });
    const types = (await h.events.list({ prUrl: PR1, limit: 50 })).map((e) => e.type);
    expect(types).toContain("approve_failed");
    expect((await h.outbox.listForMessage(CHANNEL, TS)).map((o) => o.emoji)).toEqual([PASSED]);
    expect(h.replier.replies[0]!.text).toContain("Reply `approve` to retry");
  });

  it("a repo removed from the list is never auto-approved", async () => {
    const h = harness();
    h.setRepos([]);
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);
    expect(byState(h, "APPROVED")).toEqual([]);
    expect((await h.jobs.get(job.id))!.progress[PR1]!.approve).toMatchObject({
      reason: "repo_not_allowed",
    });
  });

  it("the reply links to the record and never carries the raw model text", async () => {
    const h = harness();
    h.reviewer.answers = [
      ok({
        summary: "SECRET-SUMMARY <@U0BOSS>",
        findings: [{ severity: "P0", title: "<!channel> pwn\nnext", body: "SECRET-BODY" }],
        verificationRequests: [],
      }),
    ];
    await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);
    const record = (await h.records.latestForPr(PR1))!;
    const reply = h.replier.replies[0]!;
    expect(reply).toMatchObject({ channel: CHANNEL, threadTs: TS });
    expect(reply.text).toContain(`https://ops.test/review/${record.id}`);
    expect(reply.text).not.toContain("SECRET");
    expect(reply.text).not.toContain("<!channel>");
    expect(reply.text).toContain("&lt;!channel&gt; pwn next");
  });

  it("a crash after the review was posted does not post it again (marker lookup)", async () => {
    const h = harness();
    // The lease runs out while the review is being submitted: the checkpoint save then fails.
    h.github.beforeSubmit = (_ref, input) => {
      if (input.event !== "APPROVE") h.clock.advance(DEFAULT_REVIEW_CONSUMER_CONFIG.leaseMs + 1);
    };
    const job = await h.enqueue();
    expect(await processNextReviewJob(h.deps, OWNER)).toEqual({
      kind: "abandoned",
      jobId: job.id,
    });
    expect(byState(h, "COMMENTED")).toHaveLength(1);

    h.github.beforeSubmit = () => {};
    await processNextReviewJob(h.deps, "worker-2");
    expect(byState(h, "COMMENTED")).toHaveLength(1);
    expect(byState(h, "APPROVED")).toHaveLength(1);
    expect((await h.jobs.get(job.id))!.state).toBe("done");
    expect(h.reviewer.calls).toHaveLength(1);
  });

  it("a crash after the APPROVE was submitted finds it instead of approving twice", async () => {
    const h = harness();
    h.github.beforeSubmit = (ref, input) => {
      if (input.event !== "APPROVE") return;
      h.world.addReview(ref, { state: "APPROVED", commitId: input.commitId!, body: input.body });
      h.clock.advance(DEFAULT_REVIEW_CONSUMER_CONFIG.leaseMs + 1);
      return ok({ id: 9999 });
    };
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);
    h.github.beforeSubmit = () => {};
    await processNextReviewJob(h.deps, "worker-2");
    expect(byState(h, "APPROVED")).toHaveLength(1);
    expect((await h.jobs.get(job.id))!.progress[PR1]!.approve).toMatchObject({
      step: "approved",
    });
  });

  it("a transient LLM failure requeues; the third in a row fails the job and removes ⏳", async () => {
    const h = harness();
    h.reviewer.answers = [err({ kind: "upstream", service: "llm", retryable: true })];
    const job = await h.enqueue();

    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "queued" });
    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "queued" });
    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "failed" });

    const record = (await h.records.latestForPr(PR1))!;
    expect(record).toMatchObject({ status: "failed", errorCategory: "interrupted", run: 3 });
    expect((await h.events.list({ prUrl: PR1, limit: 10 })).map((e) => e.type)).toEqual([
      "review_failed",
    ]);
    const ops = await h.outbox.listForMessage(CHANNEL, TS);
    expect(ops).toEqual([]); // nothing placed, the target "none" needs no op
    expect(h.replier.replies[0]!.text).toContain("review failed");
    expect((await h.jobs.get(job.id))!.resultReplySent).toBe(true);
  });

  it("a poison job that outlives its lease every run fails at the third reclaim, unrun", async () => {
    const h = harness();
    // The worker hangs past its lease (a crash looks the same): every write after it is fenced.
    h.reviewer.onReview = () => {
      h.clock.advance(DEFAULT_REVIEW_CONSUMER_CONFIG.leaseMs + 1);
    };
    const job = await h.enqueue();
    for (const worker of ["w0", "w1", "w2"]) {
      expect(await processNextReviewJob(h.deps, worker)).toEqual({
        kind: "abandoned",
        jobId: job.id,
      });
    }
    expect((await h.jobs.get(job.id))!.interruptions).toBe(2);

    expect(await processNextReviewJob(h.deps, "w3")).toEqual({
      kind: "processed",
      jobId: job.id,
      state: "failed",
    });
    expect(h.reviewer.calls).toHaveLength(3); // the exhausted job never ran again
    expect(h.reviews()).toEqual([]);
    const stored = (await h.jobs.get(job.id))!;
    expect(stored).toMatchObject({ state: "failed", interruptions: 3, leaseOwner: null });
    expect(await h.records.latestForPr(PR1)).toMatchObject({
      status: "failed",
      errorCategory: "interrupted",
    });
    expect(h.replier.replies[0]!.text).toContain("review failed");
    h.clock.advance(DEFAULT_REVIEW_CONSUMER_CONFIG.leaseMs * 10);
    expect(await processNextReviewJob(h.deps, "w4")).toEqual({ kind: "idle" });
  });

  it("an LLM call past its deadline counts as an interruption, and its timer is released", async () => {
    const h = harness();
    h.timers.fireDeadlines = true;
    h.reviewer.onReview = () => new Promise(() => {});
    await h.enqueue();
    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "queued" });
    expect(h.timers.cancelled).toBeGreaterThan(0);
  });

  it("a deadline aborts the in-flight LLM call through its signal", async () => {
    const h = harness();
    let aborted: unknown = null;
    h.reviewer.onReview = () =>
      new Promise<void>(() => {
        const signal = h.reviewer.signals.at(-1)!;
        signal.addEventListener("abort", () => (aborted = signal.reason));
      });
    // Deadlines fire only once the LLM call is in flight (GitHub calls finish first).
    const deadline = h.timers.deadline.bind(h.timers);
    h.timers.deadline = (ms) =>
      ms === DEFAULT_REVIEW_CONSUMER_CONFIG.reviewTimeoutMs
        ? { done: Promise.resolve(), cancel: () => {} }
        : deadline(ms);
    await h.enqueue();
    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "queued" });
    expect(h.reviewer.signals).toHaveLength(1);
    expect(h.reviewer.signals[0]!.aborted).toBe(true);
    expect(aborted).toBeInstanceOf(Error);
    expect((aborted as Error).name).toBe("DeadlineExceeded");
  });

  it("a review that finishes in time leaves its signal unaborted", async () => {
    const h = harness();
    await h.enqueue();
    await runToEnd(h);
    expect(h.reviewer.signals).toHaveLength(1);
    expect(h.reviewer.signals[0]).toBeInstanceOf(AbortSignal);
    expect(h.reviewer.signals[0]!.aborted).toBe(false);
  });

  it("malformed model output fails at once with a validation category", async () => {
    const h = harness();
    h.reviewer.answers = [err({ kind: "validation", message: "bad json" })];
    await h.enqueue();
    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "failed" });
    expect(await h.records.latestForPr(PR1)).toMatchObject({ errorCategory: "validation" });
    expect(h.reviews()).toEqual([]);
  });

  it("no reviewer configured fails with not_configured and makes no GitHub write", async () => {
    const h = harness();
    h.deps.reviewer = async () => err({ kind: "not_configured", feature: "llm" });
    await h.enqueue();
    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "failed" });
    expect(await h.records.latestForPr(PR1)).toMatchObject({ errorCategory: "not_configured" });
    expect(h.reviews()).toEqual([]);
  });

  it("a failed terminal commit writes nothing; the next run commits exactly once", async () => {
    const h = harness();
    const job = await h.enqueue();
    h.uow.failNextCommit();
    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "queued" });
    expect(await h.records.latestForPr(PR1)).toBeNull();
    expect(await h.outbox.listForMessage(CHANNEL, TS)).toEqual([]);
    expect(await h.events.list({ prUrl: PR1, limit: 10 })).toEqual([]);
    expect(h.replier.replies).toEqual([]);

    expect(await processNextReviewJob(h.deps, OWNER)).toMatchObject({ state: "done" });
    const page = await h.records.list({ prUrl: PR1 });
    expect(page.ok && page.value.items).toHaveLength(1);
    expect(byState(h, "COMMENTED")).toHaveLength(1);
    expect(byState(h, "APPROVED")).toHaveLength(1);
    expect((await h.jobs.get(job.id))!.state).toBe("done");
  });

  it("several PRs: one record each, one aggregated 🔴, one reply with both", async () => {
    const h = harness();
    h.reviewer.answers = [ok(passing()), ok(blocking())];
    await h.enqueue({ urls: [PR1, PR2] });
    await processNextReviewJob(h.deps, OWNER);
    expect((await h.records.latestForPr(PR1))!.verdict).toBe("pass");
    expect((await h.records.latestForPr(PR2))!.verdict).toBe("changes_requested");
    expect((await h.outbox.listForMessage(CHANNEL, TS)).map((o) => o.emoji)).toEqual([CHANGES]);
    expect(h.replier.replies).toHaveLength(1);
    expect(h.replier.replies[0]!.text).toContain(PR1);
    expect(h.replier.replies[0]!.text).toContain(PR2);
  });

  it("a web job gets a record but no thread, reaction or reply", async () => {
    const h = harness();
    await h.enqueue({ source: "web", slack: undefined, actorUserId: "user-1" });
    await processNextReviewJob(h.deps, OWNER);
    expect(await h.records.latestForPr(PR1)).toMatchObject({
      source: "web",
      requester: { kind: "user", id: "user-1" },
    });
    expect(await h.outbox.listForMessage(CHANNEL, TS)).toEqual([]);
    expect(h.replier.replies).toEqual([]);
  });

  it("stops writing when another consumer took the lease", async () => {
    const h = harness();
    h.reviewer.onReview = async () => {
      h.clock.advance(DEFAULT_REVIEW_CONSUMER_CONFIG.leaseMs + 1);
      await h.jobs.claimNext({ owner: "thief", leaseMs: 60_000 });
    };
    const job = await h.enqueue();
    expect(await processNextReviewJob(h.deps, OWNER)).toEqual({
      kind: "abandoned",
      jobId: job.id,
    });
    expect(h.reviews()).toEqual([]);
    expect((await h.jobs.get(job.id))!.leaseOwner).toBe("thief");
  });

  it("property: an APPROVE is only ever pinned to the reviewed SHA, and only while it is the head", async () => {
    const pushPoint = fc.constantFrom("none", "before_review", "after_review", "before_approve");
    await fc.assert(
      fc.asyncProperty(pushPoint, fc.boolean(), async (point, verdictPass) => {
        const h = harness();
        h.reviewer.answers = [ok(verdictPass ? passing() : blocking())];
        if (point === "before_review") h.world.pushHead(ref1, SHA_B);
        if (point === "after_review") h.reviewer.onReview = () => h.world.pushHead(ref1, SHA_B);
        if (point === "before_approve") {
          h.github.beforeSubmit = (_r, input) => {
            if (input.event !== "APPROVE") h.world.pushHead(ref1, SHA_B);
          };
        }
        const job = await h.enqueue();
        await runToEnd(h);
        const reviewed = (await h.jobs.get(job.id))!.progress[PR1]!.pr!.sha;
        const approvals = byState(h, "APPROVED");
        for (const a of approvals) expect(a.commitId).toBe(reviewed);
        const headMovedAfterReview = point === "after_review" || point === "before_approve";
        expect(approvals).toHaveLength(verdictPass && !headMovedAfterReview ? 1 : 0);
        expect(h.world.count("merge")).toBe(0);
      }),
      { numRuns: 40 },
    );
  });
});

describe("result reply", () => {
  it("is sent at most once even when two senders race", async () => {
    const h = harness();
    h.deps.replier = null;
    await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);
    h.deps.replier = h.replier;
    const [a, b] = await Promise.all([
      sendPendingResultReplies(h.deps),
      sendPendingResultReplies(h.deps),
    ]);
    expect(a + b).toBe(1);
    expect(h.replier.replies).toHaveLength(1);
    expect(await sendPendingResultReplies(h.deps)).toBe(0);
  });

  it("backstop: a terminal Slack job whose reply was never sent gets it", async () => {
    const h = harness();
    h.deps.replier = null; // e.g. Slack not configured when the job finished
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);
    expect((await h.jobs.get(job.id))!.resultReplySent).toBeUndefined();

    h.deps.replier = h.replier;
    expect(await sendPendingResultReplies(h.deps)).toBe(1);
    expect(h.replier.replies[0]!.text).toContain("APPROVE");
    expect((await h.jobs.get(job.id))!.resultReplySent).toBe(true);
  });

  it("retries a failed send a bounded number of times, then gives up (at most once)", async () => {
    const h = harness();
    h.replier.failNext({ kind: "rate_limited", retryAfterMs: 2_000 }, 5);
    const job = await h.enqueue();
    await processNextReviewJob(h.deps, OWNER);
    expect(h.replier.replies).toEqual([]);
    expect(h.timers.sleeps).toEqual([2_000, 2_000]);
    expect((await h.jobs.get(job.id))!.resultReplySent).toBe(true);
    expect(h.logger.entries.some((e) => e.level === "error")).toBe(true);
  });
});
