import type { NewReviewJob, ReviewJob, ReviewJobState } from "../../domain/review-queue/types";

const T0 = new Date("2026-01-01T00:00:00.000Z");

/** A valid, queued Slack job. Dates are copies, so tests may mutate them. */
export function aReviewJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    id: "job-1",
    source: "slack",
    state: "queued",
    urls: ["https://github.com/acme/app/pull/1"],
    progress: {},
    attempts: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseUntil: null,
    slack: { channel: "C1", ts: "1700000000.000100", user: "U1" },
    version: 1,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...overrides,
  };
}

/** Input for `ReviewJobRepo.create`: repo-owned fields are dropped. */
export function aNewReviewJob(overrides: Partial<NewReviewJob> = {}): NewReviewJob {
  const {
    version: _v,
    createdAt: _c,
    updatedAt: _u,
    attempts: _a,
    leaseOwner: _o,
    leaseUntil: _l,
    nextAttemptAt: _n,
    ...rest
  } = aReviewJob();
  return { ...rest, ...overrides };
}

/**
 * A coherent job in the given state, for state-machine tests:
 * - running: leased to "w1" until T0 + 1h, one attempt
 * - failed: carries a `lastError`
 */
export function aReviewJobInState(
  state: ReviewJobState,
  overrides: Partial<ReviewJob> = {},
): ReviewJob {
  const base = aReviewJob();
  const completed = Object.fromEntries(base.urls.map((u) => [u, { completed: true }]));
  const byState: Partial<ReviewJob> = {
    queued: {},
    running: {
      leaseOwner: "w1",
      leaseUntil: new Date(T0.getTime() + 60 * 60_000),
      attempts: 1,
    },
    failed: { progress: {}, attempts: 1, lastError: "boom" },
    done: { progress: completed, attempts: 1 },
  }[state];
  return aReviewJob({ state, ...byState, ...overrides });
}
