/**
 * Pure review job state machine (architecture.md section 4). No Date.now(), no I/O: the caller passes `now`.
 * The repo owns `version`, `createdAt`, and persistence; this module never touches them.
 *
 * Derived from: slack-review-runner.ts (runSlackReviewJob), slack-review-queue.ts (processSlackReviewJob,
 * retryFailedSlackReviewJobs, runnable) and ship-pr.ts (ShipProgress checkpoints).
 *
 * Deliberate deviations from today's lib behaviour:
 *  D1. An explicit `claimed` event moves queued -> running with a lease and counts one `attempts`. Today the
 *      lock is external and there is no attempts counter. The failure limit is still driven by
 *      `interruptions` (3 consecutive), as today. `attempts` is informational and monotonic.
 *  D2. Today a stale `running` job is re-run in place after interruptions++. Here `lease_expired` /
 *      `interrupted` send it back to `queued` (or to `failed` at the 3rd) and a new `claimed` follows.
 *  D3. `retry` also clears `resultReplySent`. Today it stays true after the failure reply, which would
 *      suppress the success reply of a retried job.
 *  D4. `deferred` takes an optional `retryAt` (today always "immediately", i.e. null).
 *  D5. A queued job honours `nextAttemptAt` on claim (today only reaction_pending does). Only `deferred`
 *      with `retryAt` can set it on a queued job, so default behaviour is unchanged.
 *  D6. Checkpoints are validated: monotonic booleans, write-once commentId / githubReviewId / review,
 *      schema-checked merge result. Today any ShipProgress object overwrites the previous one.
 *  D7. Events invalid for the state, a duplicate `url_completed`/`reply_sent` and `all_completed` before
 *      every URL is completed return `conflict`.
 *  D8. The interruption failure text is English; the user-facing text is rendered from state, not error text.
 *  D9. Every job reaches `done` from `all_completed` directly. There is no `reaction_pending` step
 *      (architecture.md section 4, FR-SLACK-08): the terminal transition hands `ReactionIntent`s to the
 *      reaction outbox, and the result reply (`reply_sent`) is recorded on the terminal job, at most once.
 *  D10. Auto-approve checkpoint (FR-SHIP-01): on a 🟢 verdict, after the comment checkpoint,
 *      `approve_started` writes `approve_pending` pinned to the reviewed head SHA (`pr.sha`) before the
 *      GitHub call, and `approve_finished` writes `approved` / `approve_skipped` / `approve_failed`.
 *      Both are idempotent per SHA, so a restarted run can replay them. A 🟢 URL cannot complete until the
 *      outcome is recorded; a failed APPROVE never fails the job.
 *  D11. The terminal transition (entering `done` or `failed`) is the only one that produces review records
 *      (FR-REVIEW-05): one per URL, except completed URLs already recorded by an earlier run of the job.
 *      `step` returns them with the reaction intents; the caller writes job, records and outbox rows in one
 *      transaction.
 *  D12. A lease-expired reclaim counts as one interruption. The repo's claim query increments
 *      `interruptions` atomically when it takes over a `running` job (the old owner crashed or hung) and
 *      keeps `runStartedAt`. A reclaimed job that reached `MAX_INTERRUPTIONS` is not run again: the new
 *      owner sends `interruption_limit`, which fails it (category `interrupted`) through the normal
 *      terminal transition, so its records and reaction intents are written atomically. The repo never
 *      enters a terminal state itself; if the new owner dies too, the next reclaim is exhausted again.
 *
 * State diagram:
 *   queued -claimed-> running -all_completed-> done
 *   running -deferred / interrupted(<3) / lease_expired(<3)-> queued
 *   running -failed / interrupted(3) / lease_expired(3) / interruption_limit-> failed -retry-> queued
 *   running(lease expired) -repo reclaim, interruptions + 1-> running
 *   per 🟢 URL inside running: commented -> approve_pending -> approved | approve_skipped | approve_failed
 */

import { decideGithubEvent, highestSeverity, reviewVerdict } from "../review/review";
import type {
  ApproveOutcome,
  Finding,
  ReviewFailureCategory,
  ReviewRecord,
  ReviewRequester,
} from "../review/types";
import { err, ok, type DomainError, type Result } from "../shared/result";
import { ApproveOutcomeSchema, UrlProgressSchema, toValidationError } from "./progress";
import type {
  ReactionIntent,
  ReviewJob,
  ReviewJobState,
  ReviewStatusTarget,
  UrlProgress,
} from "./types";

export const MAX_INTERRUPTIONS = 3;

const FAILURE_CATEGORIES: readonly ReviewFailureCategory[] = [
  "interrupted",
  "upstream",
  "validation",
  "not_configured",
  "internal",
];

export type ReviewJobEvent =
  | { type: "claimed"; owner: string; leaseMs: number }
  | { type: "lease_expired" }
  | { type: "interrupted" }
  /** Sent by the owner of a reclaimed job whose interruptions are exhausted (D12). */
  | { type: "interruption_limit" }
  | {
      type: "checkpoint";
      url: string;
      patch: Partial<Omit<UrlProgress, "completed" | "approve" | "recorded">>;
    }
  | { type: "url_completed"; url: string }
  | { type: "deferred"; retryAt?: Date }
  | { type: "all_completed" }
  | { type: "reply_sent" }
  | { type: "failed"; error: string; category?: ReviewFailureCategory }
  | { type: "retry" }
  | { type: "approve_started"; url: string; sha: string }
  | { type: "approve_finished"; url: string; outcome: ApproveOutcome };

/** The new job plus the effects the caller must persist atomically with it. */
export type TransitionOutcome = {
  job: ReviewJob;
  /** Non-empty only on the terminal transition. */
  records: ReviewRecord[];
  /** Reaction outbox intents: on the terminal transition, and ⏳ again on `retry`. */
  intents: ReactionIntent[];
};

type Out = Result<TransitionOutcome, DomainError>;

const conflict = (reason: string): Out => err({ kind: "conflict", reason });
const invalid = (field: string, message: string): Out =>
  err({ kind: "validation", field, message });
const wrongState = (job: ReviewJob, event: ReviewJobEvent): Out =>
  conflict(`event ${event.type} is not allowed in state ${job.state}`);
const only = (job: ReviewJob): Out => ok({ job, records: [], intents: [] });

function next(job: ReviewJob, now: Date, changes: Partial<ReviewJob>): ReviewJob {
  return { ...job, ...changes, updatedAt: new Date(now) };
}

function omit(job: ReviewJob, ...keys: (keyof ReviewJob)[]): ReviewJob {
  const copy = { ...job };
  for (const key of keys) delete copy[key];
  return copy;
}

const released = { leaseOwner: null, leaseUntil: null } as const;

function leaseFree(job: ReviewJob, now: Date): boolean {
  return job.leaseUntil === null || job.leaseUntil.getTime() <= now.getTime();
}

function due(job: ReviewJob, now: Date): boolean {
  return job.nextAttemptAt === null || job.nextAttemptAt.getTime() <= now.getTime();
}

const FLAGS = ["reviewed", "commented", "submitted", "merged", "replied", "reacted"] as const;
const WRITE_ONCE = ["commentId", "githubReviewId", "review", "reviewSeq"] as const;
/** Keys only dedicated events may write. */
const RESERVED = ["completed", "approve", "recorded"] as const;

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    ka.length === kb.length &&
    ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

const isPass = (p: UrlProgress): boolean =>
  p.review !== undefined && reviewVerdict(p.review.findings) === "pass";

// ---------------------------------------------------------------------------
// Terminal effects: review records and reaction intents
// ---------------------------------------------------------------------------

function requesterOf(job: ReviewJob): ReviewRequester | null {
  if (job.source === "slack") return job.slack?.user ? { kind: "slack", id: job.slack.user } : null;
  return job.actorUserId ? { kind: "user", id: job.actorUserId } : null;
}

function intent(job: ReviewJob, url: string, target: ReviewStatusTarget): ReactionIntent[] {
  if (job.source !== "slack" || !job.slack) return [];
  return [
    {
      prUrl: url,
      jobId: job.id,
      reviewSeq: job.progress[url]?.reviewSeq ?? 0,
      channel: job.slack.channel,
      ts: job.slack.ts,
      target,
    },
  ];
}

function buildRecord(
  job: ReviewJob,
  url: string,
  p: UrlProgress,
  now: Date,
  failure: ReviewFailureCategory,
): ReviewRecord {
  const done = p.completed === true;
  const findings: Finding[] = (p.review?.findings ?? []).map((f) => ({ ...f }));
  const verdictKnown = done && p.review !== undefined;
  return {
    jobId: job.id,
    prUrl: url,
    attempt: job.attempts,
    reviewSeq: p.reviewSeq ?? 0,
    source: job.source,
    requester: requesterOf(job),
    pr: p.pr
      ? {
          owner: p.pr.owner,
          repo: p.pr.repo,
          number: p.pr.number,
          headSha: p.pr.sha,
          baseSha: p.pr.baseSha,
        }
      : null,
    status: done ? "done" : "failed",
    verdict: verdictKnown ? reviewVerdict(findings) : null,
    githubEvent: verdictKnown ? decideGithubEvent(findings) : null,
    highestSeverity: verdictKnown ? highestSeverity(findings) : null,
    summary: p.review?.summary ?? null,
    findings,
    verificationRequests: [...(p.review?.verificationRequests ?? [])],
    approve: p.approve ? { ...p.approve } : null,
    failure: done ? null : failure,
    startedAt: new Date(job.runStartedAt ?? job.createdAt),
    finishedAt: new Date(now),
  };
}

/** Builds the effects of entering `done` / `failed`. Completed URLs are recorded once per job. */
function enterTerminal(
  job: ReviewJob,
  now: Date,
  failure: ReviewFailureCategory,
): TransitionOutcome {
  const records: ReviewRecord[] = [];
  const intents: ReactionIntent[] = [];
  const progress = { ...job.progress };
  for (const url of job.urls) {
    const p = job.progress[url] ?? {};
    if (p.completed && p.recorded) continue;
    records.push(buildRecord(job, url, p, now, failure));
    const target: ReviewStatusTarget =
      p.completed && p.review ? reviewVerdict(p.review.findings) : "none";
    intents.push(...intent(job, url, target));
    if (p.completed) progress[url] = { ...p, recorded: true };
  }
  return { job: { ...job, progress }, records, intents };
}

function fail(
  job: ReviewJob,
  now: Date,
  changes: Partial<ReviewJob>,
  category: ReviewFailureCategory,
): Out {
  const failed = next(job, now, { state: "failed", nextAttemptAt: null, ...released, ...changes });
  return ok(enterTerminal(failed, now, category));
}

/** True once a job has been interrupted `MAX_INTERRUPTIONS` times in a row; it must not run again. */
export function interruptionsExhausted(job: Pick<ReviewJob, "interruptions">): boolean {
  return (job.interruptions ?? 0) >= MAX_INTERRUPTIONS;
}

function failInterrupted(job: ReviewJob, now: Date, count: number): Out {
  return fail(
    job,
    now,
    {
      interruptions: count,
      lastError: `Interrupted ${count} consecutive times (possibly exceeded the function duration limit); automatic retry stopped.`,
    },
    "interrupted",
  );
}

function applyInterruption(job: ReviewJob, now: Date): Out {
  const count = (job.interruptions ?? 0) + 1;
  if (count >= MAX_INTERRUPTIONS) return failInterrupted(job, now, count);
  return only(next(job, now, { state: "queued", interruptions: count, ...released }));
}

// ---------------------------------------------------------------------------
// Per-URL events
// ---------------------------------------------------------------------------

type UrlCheck = { ok: true; progress: UrlProgress } | { ok: false; out: Out };

/** Common guard for per-URL events: running, known URL, not completed. */
function openUrl(job: ReviewJob, event: ReviewJobEvent & { url: string }): UrlCheck {
  if (job.state !== "running") return { ok: false, out: wrongState(job, event) };
  if (!job.urls.includes(event.url)) {
    return { ok: false, out: invalid("url", "url is not part of this job") };
  }
  const progress: UrlProgress = job.progress[event.url] ?? {};
  if (progress.completed)
    return { ok: false, out: conflict(`url is already completed: ${event.url}`) };
  return { ok: true, progress };
}

function withProgress(
  job: ReviewJob,
  now: Date,
  url: string,
  merged: Record<string, unknown>,
): Out {
  const parsed = UrlProgressSchema.safeParse(merged);
  if (!parsed.success) return err(toValidationError(parsed.error));
  return only(next(job, now, { progress: { ...job.progress, [url]: parsed.data as UrlProgress } }));
}

function checkpoint(
  job: ReviewJob,
  event: Extract<ReviewJobEvent, { type: "checkpoint" }>,
  now: Date,
): Out {
  const open = openUrl(job, event);
  if (!open.ok) return open.out;
  const current = open.progress;
  const patch = event.patch as Record<string, unknown>;
  for (const key of RESERVED) {
    if (key in patch) return conflict(`checkpoint cannot write ${key}; use its dedicated event`);
  }
  for (const flag of FLAGS) {
    if (current[flag] === true && patch[flag] !== undefined && patch[flag] !== true) {
      return conflict(`checkpoint flag ${flag} is monotonic`);
    }
  }
  for (const key of WRITE_ONCE) {
    if (current[key] !== undefined && key in patch && !deepEqual(current[key], patch[key])) {
      return conflict(`checkpoint ${key} is write-once`);
    }
  }
  if (current.review !== undefined && "pr" in patch && !deepEqual(current.pr, patch.pr)) {
    return conflict("pr cannot change once the review exists");
  }
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (!(key in merged)) continue;
      // Only the partial batch review (dropped when a fresh review starts) and `result` may be unset.
      if (key !== "batchReview" && key !== "result")
        return conflict(`checkpoint ${key} cannot be removed`);
      delete merged[key];
    } else merged[key] = value;
  }
  const out = withProgress(job, now, event.url, merged);
  if (!out.ok) return out;
  const firstReview = current.review === undefined && merged.review !== undefined;
  // A completed review is progress, even if a later GitHub step is interrupted (runner).
  return firstReview ? only({ ...out.value.job, interruptions: 0 }) : out;
}

function approveStarted(
  job: ReviewJob,
  event: Extract<ReviewJobEvent, { type: "approve_started" }>,
  now: Date,
): Out {
  const open = openUrl(job, event);
  if (!open.ok) return open.out;
  const p = open.progress;
  if (typeof event.sha !== "string" || event.sha.length === 0) {
    return invalid("sha", "sha is required");
  }
  if (p.approve !== undefined) {
    // Replayed after a restart: a no-op for the pinned SHA, whatever step it reached.
    return p.approve.sha === event.sha
      ? only(job)
      : conflict(`approve is pinned to the reviewed sha ${p.approve.sha}`);
  }
  if (p.review === undefined) return conflict("approve needs a review checkpoint");
  if (p.pr === undefined) return conflict("approve needs the PR checkpoint (reviewed head sha)");
  if (p.commented !== true) return conflict("approve runs after the comment checkpoint");
  if (!isPass(p)) return conflict("approve needs a passing verdict");
  if (event.sha !== p.pr.sha) {
    return conflict("approve sha does not match the reviewed head sha");
  }
  return withProgress(job, now, event.url, {
    ...p,
    approve: { step: "approve_pending", sha: event.sha },
  });
}

function approveFinished(
  job: ReviewJob,
  event: Extract<ReviewJobEvent, { type: "approve_finished" }>,
  now: Date,
): Out {
  const open = openUrl(job, event);
  if (!open.ok) return open.out;
  const p = open.progress;
  const parsed = ApproveOutcomeSchema.safeParse(event.outcome);
  if (!parsed.success) return err(toValidationError(parsed.error));
  const outcome = parsed.data as ApproveOutcome;
  if (p.approve === undefined) return conflict("approve_pending must be recorded first");
  if (p.approve.sha !== outcome.sha) {
    return conflict(`approve outcome sha does not match the pinned sha ${p.approve.sha}`);
  }
  if (p.approve.step !== "approve_pending") {
    return deepEqual(p.approve, outcome) ? only(job) : conflict("approve outcome is write-once");
  }
  return withProgress(job, now, event.url, { ...p, approve: outcome });
}

/**
 * Applies one event and returns the new job with its effects. Returns `conflict` for an illegal
 * transition and `validation` for bad input; never throws, never mutates its input.
 */
export function step(job: ReviewJob, event: ReviewJobEvent, now: Date): Out {
  const state: ReviewJobState = job.state;
  switch (event.type) {
    case "claimed": {
      if (state !== "queued") return wrongState(job, event);
      if (!event.owner || !Number.isFinite(event.leaseMs) || event.leaseMs <= 0) {
        return invalid("lease", "owner and a positive leaseMs are required");
      }
      if (!leaseFree(job, now)) return conflict("lease is still held by another owner");
      if (!due(job, now)) return conflict("job is not due yet (nextAttemptAt in the future)");
      return only(
        next(job, now, {
          state: "running",
          nextAttemptAt: null,
          leaseOwner: event.owner,
          leaseUntil: new Date(now.getTime() + event.leaseMs),
          attempts: job.attempts + 1,
          runStartedAt: new Date(job.runStartedAt ?? now),
        }),
      );
    }
    case "lease_expired": {
      if (state !== "running") return wrongState(job, event);
      if (job.leaseUntil === null) return conflict("job has no lease to expire");
      if (job.leaseUntil.getTime() > now.getTime()) return conflict("lease has not expired yet");
      return applyInterruption(job, now);
    }
    case "interrupted":
      return state === "running" ? applyInterruption(job, now) : wrongState(job, event);
    case "interruption_limit": {
      if (state !== "running") return wrongState(job, event);
      if (!interruptionsExhausted(job)) {
        return conflict(
          `interruption limit not reached (${job.interruptions ?? 0}/${MAX_INTERRUPTIONS})`,
        );
      }
      // The reclaim already counted this interruption; do not count it twice.
      return failInterrupted(job, now, job.interruptions ?? 0);
    }
    case "checkpoint":
      return checkpoint(job, event, now);
    case "approve_started":
      return approveStarted(job, event, now);
    case "approve_finished":
      return approveFinished(job, event, now);
    case "url_completed": {
      const open = openUrl(job, event);
      if (!open.ok) return open.out;
      const p = open.progress;
      if (isPass(p) && (p.approve === undefined || p.approve.step === "approve_pending")) {
        return conflict("a passing URL completes only after its approve outcome is recorded");
      }
      return only(
        next(job, now, { progress: { ...job.progress, [event.url]: { ...p, completed: true } } }),
      );
    }
    case "deferred": {
      if (state !== "running") return wrongState(job, event);
      if (event.retryAt && event.retryAt.getTime() < now.getTime()) {
        return invalid("retryAt", "retryAt is in the past");
      }
      return only(
        omit(
          next(job, now, {
            state: "queued",
            nextAttemptAt: event.retryAt ? new Date(event.retryAt) : null,
            ...released,
          }),
          "lastError",
        ),
      );
    }
    case "all_completed": {
      if (state !== "running") return wrongState(job, event);
      if (job.urls.length === 0) return conflict("job has no urls");
      if (!job.urls.every((url) => job.progress[url]?.completed === true)) {
        return conflict("not every url is completed");
      }
      const done = omit(
        next(job, now, { state: "done", nextAttemptAt: null, ...released }),
        "lastError",
      );
      return ok(enterTerminal(done, now, "internal"));
    }
    case "reply_sent": {
      if (state !== "done" && state !== "failed") return wrongState(job, event);
      if (job.resultReplySent) return conflict("result reply was already sent");
      return only(next(job, now, { resultReplySent: true }));
    }
    case "failed": {
      if (state !== "running") return wrongState(job, event);
      const category = event.category ?? "internal";
      if (!FAILURE_CATEGORIES.includes(category)) {
        return invalid("category", "unknown failure category");
      }
      return fail(job, now, { lastError: event.error }, category);
    }
    case "retry": {
      if (state !== "failed") return wrongState(job, event);
      const queued = omit(
        next(job, now, { state: "queued", nextAttemptAt: null, ...released }),
        "lastError",
        "interruptions",
        "resultReplySent",
        "runStartedAt",
      );
      const intents = queued.urls
        .filter((url) => !(queued.progress[url]?.completed && queued.progress[url]?.recorded))
        .flatMap((url) => intent(queued, url, "reviewing"));
      return ok({ job: queued, records: [], intents });
    }
    default:
      return invalid("type", "unknown event type");
  }
}

/** `step` without the effects, for callers that only need the next job. */
export function transition(
  job: ReviewJob,
  event: ReviewJobEvent,
  now: Date,
): Result<ReviewJob, DomainError> {
  const out = step(job, event, now);
  return out.ok ? ok(out.value.job) : out;
}

// ---------------------------------------------------------------------------
// Review sequence per PR: a re-review supersedes the earlier one (latest wins)
// ---------------------------------------------------------------------------

/**
 * The sequence for a new review of a PR, given the latest stored one (none: 1).
 * Throws `RangeError` on a corrupt stored value rather than guessing: a guessed, lower sequence would
 * let an older review's emoji win.
 */
export function nextReviewSeq(latest: number | null | undefined): number {
  if (latest === null || latest === undefined) return 1;
  if (!Number.isSafeInteger(latest) || latest < 0) {
    throw new RangeError("stored review sequence is not a non-negative integer");
  }
  return latest + 1;
}

/** Progress for a new job: each URL gets the next sequence of its own PR. */
export function initialProgress(
  urls: readonly string[],
  latestSeq: (url: string) => number | null | undefined,
): Record<string, UrlProgress> {
  return Object.fromEntries(urls.map((url) => [url, { reviewSeq: nextReviewSeq(latestSeq(url)) }]));
}

/** ⏳ for every PR of a newly accepted Slack review job, written with the job (FR-SLACK-14). */
export function reviewAcceptedIntents(job: ReviewJob): ReactionIntent[] {
  return job.urls.flatMap((url) => intent(job, url, "reviewing"));
}

/** True when `a` is a later review of the same PR than `b`, so `b`'s pending intents are dropped. */
export function supersedes(
  a: { prUrl: string; reviewSeq: number },
  b: { prUrl: string; reviewSeq: number },
): boolean {
  return a.prUrl === b.prUrl && a.reviewSeq > b.reviewSeq;
}
