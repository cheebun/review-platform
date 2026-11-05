/** Shared wiring for the review and ship use-case tests: every port is an in-memory fake. */
import type { PrRef } from "../../domain/github/pr-ref";
import type { AiReviewResult, Finding } from "../../domain/review/types";
import type { NewReviewJob } from "../../domain/review-queue/types";
import { initialProgress } from "../../domain/review-queue/state-machine";
import { ok, type DomainError, type Result } from "../../domain/shared/result";
import type { SubmitReviewInput } from "../../ports/github";
import { DEFAULT_REACTION_RETRY } from "../../ports/reaction-outbox";
import type { LlmCallOptions } from "../../ports/llm-call";
import type { Reviewer, ReviewInput } from "../../ports/reviewer";
import { aNewReviewJob } from "../../testing/builders/review-job";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { FakeGitHub } from "../../testing/fakes/fake-github";
import { InMemoryReactionOutbox } from "../../testing/fakes/in-memory-reaction-outbox";
import { InMemoryReviewEventRepo } from "../../testing/fakes/in-memory-review-event-repo";
import { InMemoryReviewJobRepo } from "../../testing/fakes/in-memory-review-job-repo";
import { InMemoryReviewRecordRepo } from "../../testing/fakes/in-memory-review-record-repo";
import { InMemoryThreadReviewIndex } from "../../testing/fakes/in-memory-thread-review-index";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { SequenceIdGenerator } from "../../testing/fakes/sequence-id-generator";
import { GithubWorld } from "../../testing/http/github/world";
import type { ReviewConsumerDeps } from "./review-job-consumer";
import {
  FakeReactionSender,
  FakeThreadReplier,
  FakeTimers,
  InMemoryReviewUnitOfWork,
} from "./testing";

export const T0 = new Date("2026-11-04T02:00:00.000Z");
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const BASE = "c".repeat(40);
export const PR1 = "https://github.com/acme/app/pull/1";
export const PR2 = "https://github.com/acme/app/pull/2";
export const CHANNEL = "C0REVIEW";
export const TS = "1700000000.000100";
export const REQUESTER = "U0ALICE";

export const finding = (severity: Finding["severity"], title = `${severity} issue`): Finding => ({
  severity,
  title,
  body: "details",
});

export const passing = (): AiReviewResult => ({
  summary: "Looks fine.",
  findings: [finding("P2")],
  verificationRequests: ["Run it."],
});

export const blocking = (): AiReviewResult => ({
  summary: "Broken.",
  findings: [finding("P0", "Null deref"), finding("P1", "Leak")],
  verificationRequests: [],
});

/** Scripted reviewer; `onReview` runs before it answers (e.g. to push a new head). */
export class ScriptedReviewer implements Reviewer {
  readonly calls: ReviewInput[] = [];
  /** The `signal` of each call, in order (undefined when none was passed). */
  readonly signals: (AbortSignal | undefined)[] = [];
  onReview: (input: ReviewInput) => void | Promise<void> = () => {};
  constructor(public answers: Result<AiReviewResult, DomainError>[] = [ok(passing())]) {}
  async review(
    input: ReviewInput,
    options?: LlmCallOptions,
  ): Promise<Result<AiReviewResult, DomainError>> {
    this.calls.push(input);
    this.signals.push(options?.signal);
    await this.onReview(input);
    return this.answers[Math.min(this.calls.length, this.answers.length) - 1]!;
  }
}

/** FakeGitHub with a hook on writes, for faults that hit exactly one call. */
export class HookedGitHub extends FakeGitHub {
  beforeSubmit: (ref: PrRef, input: SubmitReviewInput) => Result<{ id: number }> | void = () => {};
  override async submitReview(ref: PrRef, input: SubmitReviewInput) {
    const hooked = this.beforeSubmit(ref, input);
    if (hooked) return hooked;
    return super.submitReview(ref, input);
  }
}

export function harness() {
  const clock = new FakeClock(T0);
  const jobs = new InMemoryReviewJobRepo(clock);
  const records = new InMemoryReviewRecordRepo();
  const events = new InMemoryReviewEventRepo();
  const threads = new InMemoryThreadReviewIndex(clock);
  const outbox = new InMemoryReactionOutbox(clock, { ...DEFAULT_REACTION_RETRY, jitter: () => 0 });
  const uow = new InMemoryReviewUnitOfWork({ jobs, records, events, threads, outbox, clock });
  const world = new GithubWorld();
  const github = new HookedGitHub(world);
  const reviewer = new ScriptedReviewer();
  const replier = new FakeThreadReplier();
  const sender = new FakeReactionSender();
  const timers = new FakeTimers();
  const logger = new MemoryLogger();
  const ids = new SequenceIdGenerator();
  let repos: string[] = ["acme/app"];

  for (const number of [1, 2]) {
    world.addPr({ owner: "acme", repo: "app", number, headSha: SHA_A, baseSha: BASE });
    world.setFiles({ owner: "acme", repo: "app", number }, [
      { filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);
  }

  const deps: ReviewConsumerDeps = {
    jobs,
    records,
    events,
    threads,
    uow,
    github,
    reviewer: async () => ok(reviewer),
    repoList: async () => repos,
    replier,
    reviewLink: (id) => `https://ops.test/review/${id}`,
    reviewerLabel: () => ({ provider: "anthropic", model: "test-model" }),
    clock,
    ids,
    logger,
    timers,
  };

  async function enqueue(overrides: Partial<NewReviewJob> = {}) {
    const urls = overrides.urls ?? [PR1];
    const created = await jobs.create(
      aNewReviewJob({
        id: `job-${ids.uuid()}`,
        urls,
        progress: initialProgress(urls, () => null),
        slack: { channel: CHANNEL, ts: TS, user: REQUESTER },
        ...overrides,
      }),
    );
    if (!created.ok) throw new Error("enqueue failed");
    return created.value;
  }

  return {
    clock,
    jobs,
    records,
    events,
    threads,
    outbox,
    uow,
    world,
    github,
    reviewer,
    replier,
    sender,
    timers,
    logger,
    ids,
    deps,
    enqueue,
    setRepos: (r: string[]) => void (repos = r),
    reviews: (number = 1) => world.listReviews({ owner: "acme", repo: "app", number }),
  };
}
