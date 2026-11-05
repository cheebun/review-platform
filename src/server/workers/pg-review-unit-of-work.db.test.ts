import { describe, expect, it } from "vitest";
import {
  PgReactionOutbox,
  PgReviewEventRepo,
  PgReviewJobRepo,
  PgReviewRecordRepo,
  PgThreadReviewIndex,
} from "../../adapters/db";
import { pgliteFixture } from "../../adapters/db/pglite-fixture";
import {
  CHANNEL,
  harness,
  PR1,
  REQUESTER,
  SHA_A,
  TS,
} from "../../application/review/harness.test-support";
import { processNextReviewJob } from "../../application/review/review-job-consumer";
import { initialProgress } from "../../domain/review-queue/state-machine";
import { err, ok } from "../../domain/shared/result";
import { PASSED } from "../../domain/slack/status-emoji";
import { DEFAULT_REACTION_RETRY } from "../../ports/reaction-outbox";
import type { NewReviewRecord } from "../../ports/review-record-repo";
import { aNewReviewJob } from "../../testing/builders/review-job";
import { PgReviewUnitOfWork } from "./pg-review-unit-of-work";

const pg = pgliteFixture();

function stores() {
  const h = harness();
  const db = pg.db();
  const jobs = new PgReviewJobRepo(db, h.clock);
  const records = new PgReviewRecordRepo(db);
  const events = new PgReviewEventRepo(db);
  const threads = new PgThreadReviewIndex(db, h.clock);
  const outbox = new PgReactionOutbox(db, h.clock, { ...DEFAULT_REACTION_RETRY, jitter: () => 0 });
  const uow = new PgReviewUnitOfWork(db, h.clock, h.logger);
  return { h, jobs, records, events, threads, outbox, uow };
}

async function claimedJob(s: ReturnType<typeof stores>) {
  const created = await s.jobs.create(
    aNewReviewJob({
      id: "job-1",
      urls: [PR1],
      progress: initialProgress([PR1], () => null),
      slack: { channel: CHANNEL, ts: TS, user: REQUESTER },
    }),
  );
  if (!created.ok) throw new Error("create failed");
  const claimed = await s.jobs.claimNext({ owner: "w", leaseMs: 60_000 });
  if (!claimed) throw new Error("claim failed");
  return claimed;
}

const record = (over: Partial<NewReviewRecord> = {}): NewReviewRecord => ({
  id: "rec-1",
  jobId: "job-1",
  run: 1,
  prUrl: PR1,
  owner: "acme",
  repo: "app",
  number: 1,
  headSha: SHA_A,
  source: "slack",
  requester: { kind: "slack", id: REQUESTER },
  startedAt: new Date("2026-11-04T02:00:00Z"),
  finishedAt: new Date("2026-11-04T02:01:00Z"),
  status: "completed",
  verdict: "pass",
  findings: [],
  ...over,
});

const event = {
  id: "ev-1",
  type: "review_finished",
  actor: { kind: "system", id: "x" },
  prUrl: PR1,
  jobId: "job-1",
} as const;

describe("PgReviewUnitOfWork", () => {
  it("commits the job, record, event, thread and reaction together", async () => {
    const s = stores();
    const job = await claimedJob(s);
    const out = await s.uow.run(async (tx) => {
      const saved = await tx.saveJob(
        { ...job, state: "done" },
        { expectedVersion: job.version, owner: "w" },
      );
      if (!saved.ok) return saved;
      const inserted = await tx.insertRecord(record());
      if (!inserted.ok) return inserted;
      await tx.appendEvent({ ...event, at: s.h.clock.now() });
      const thread = await tx.recordThreadReview({
        channel: CHANNEL,
        threadTs: TS,
        prUrls: [PR1],
        requesterSlackId: REQUESTER,
        reviewId: "rec-1",
      });
      if (!thread.ok) return thread;
      const queued = await tx.enqueueReaction({
        channel: CHANNEL,
        ts: TS,
        prUrl: PR1,
        state: { status: PASSED, merged: false, seq: 5, reviewId: "rec-1" },
      });
      return queued.ok ? ok(thread.value.reviewSeq) : queued;
    });
    expect(out).toEqual(ok(1));
    expect((await s.jobs.get("job-1"))!.state).toBe("done");
    expect(await s.records.get("rec-1")).not.toBeNull();
    expect(await s.events.list({ prUrl: PR1, limit: 5 })).toHaveLength(1);
    expect((await s.threads.get({ channel: CHANNEL, threadTs: TS }))!.reviewSeq).toBe(1);
    expect((await s.outbox.listForMessage(CHANNEL, TS)).map((o) => o.emoji)).toEqual([PASSED]);
  });

  it("an err result rolls every write back and is returned", async () => {
    const s = stores();
    const job = await claimedJob(s);
    const out = await s.uow.run(async (tx) => {
      await tx.saveJob({ ...job, state: "done" }, { expectedVersion: job.version, owner: "w" });
      await tx.insertRecord(record());
      await tx.appendEvent({ ...event, at: s.h.clock.now() });
      return err({ kind: "conflict", reason: "later step refused" });
    });
    expect(out).toEqual(err({ kind: "conflict", reason: "later step refused" }));
    expect((await s.jobs.get("job-1"))!.state).toBe("running");
    expect(await s.records.get("rec-1")).toBeNull();
    expect(await s.events.list({ prUrl: PR1, limit: 5 })).toEqual([]);
  });

  it("a throw rolls back and is re-thrown", async () => {
    const s = stores();
    await claimedJob(s);
    await expect(
      s.uow.run(async (tx) => {
        await tx.insertRecord(record());
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await s.records.get("rec-1")).toBeNull();
  });

  it("a stale job version is a conflict and nothing is written", async () => {
    const s = stores();
    const job = await claimedJob(s);
    const out = await s.uow.run(async (tx) => {
      const saved = await tx.saveJob(job, { expectedVersion: job.version - 1, owner: "w" });
      if (!saved.ok) return saved;
      return tx.insertRecord(record());
    });
    expect(out).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await s.records.get("rec-1")).toBeNull();
  });

  it("the consumer runs end to end on Postgres", async () => {
    const s = stores();
    const deps = {
      ...s.h.deps,
      jobs: s.jobs,
      records: s.records,
      events: s.events,
      threads: s.threads,
      uow: s.uow,
    };
    await s.jobs.create(
      aNewReviewJob({
        id: "job-e2e",
        urls: [PR1],
        progress: initialProgress([PR1], () => null),
        slack: { channel: CHANNEL, ts: TS, user: REQUESTER },
      }),
    );
    expect(await processNextReviewJob(deps, "w")).toEqual({
      kind: "processed",
      jobId: "job-e2e",
      state: "done",
    });
    expect((await s.records.latestForPr(PR1))!).toMatchObject({
      status: "completed",
      verdict: "pass",
    });
    expect((await s.events.list({ prUrl: PR1, limit: 10 })).map((e) => e.type).toSorted()).toEqual([
      "approved",
      "comment_posted",
      "review_finished",
    ]);
    expect((await s.outbox.listForMessage(CHANNEL, TS)).map((o) => [o.op, o.emoji, o.seq])).toEqual(
      [["add", PASSED, 5]],
    );
    expect(s.h.replier.replies).toHaveLength(1);
    expect(
      s.h
        .reviews()
        .map((r) => r.state)
        .toSorted(),
    ).toEqual(["APPROVED", "COMMENTED"]);
  });
});
