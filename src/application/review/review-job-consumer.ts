/**
 * Review job consumer (architecture §4, FR-REVIEW-05/06, FR-SHIP-01, FR-SHIP-07, FR-SLACK-07/08).
 *
 * One claimed job runs URL by URL through the checkpoints of the pure state machine (3c):
 *
 *   diff → review (LLM, untrusted PR text delimited by the Reviewer adapter) → GitHub review pinned
 *   to `commit_id` → on 🟢: approve_pending → autoApprovePlan → approved | approve_skipped |
 *   approve_failed → url_completed … → all_completed
 *
 * Every step is saved (compare-and-set, lease held) before the next external write, and every
 * GitHub write is found again by its marker after a restart, so a write happens at most once.
 * The terminal transition writes the job, its review records, their events, the thread index and
 * the reaction target in ONE transaction. The Slack result reply follows, at most once.
 */
import { createHash } from "node:crypto";
import { parsePrUrl, type PrRef } from "../../domain/github/pr-ref";
import {
  buildReviewCommentBody,
  buildReviewDiff,
  reviewCommentMarker,
  reviewVerdict,
} from "../../domain/review/review";
import type {
  AiReviewResult,
  ApproveOutcome,
  ReviewFailureCategory,
  ReviewRecord as DomainRecord,
} from "../../domain/review/types";
import {
  interruptionsExhausted,
  step,
  type ReviewJobEvent,
  type TransitionOutcome,
} from "../../domain/review-queue/state-machine";
import type {
  PrCheckpoint,
  ReviewJob,
  ReviewJobState,
  UrlProgress,
} from "../../domain/review-queue/types";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import { autoApprovePlan, type ApprovalRecord } from "../../domain/ship/policy";
import type { GitHubPort } from "../../ports/github";
import type { ReviewEventRepo } from "../../ports/review-event-repo";
import type { ReviewJobRepo } from "../../ports/review-job-repo";
import type { NewReviewRecord, ReviewRecordRepo } from "../../ports/review-record-repo";
import type { IdGenerator, Clock, Logger } from "../../ports/system";
import type { ThreadReviewIndex } from "../../ports/thread-review-index";
import type { ReviewerSource, ReviewUnitOfWork, ThreadReplier, Timers } from "./ports";
import { verdictTarget, type PrOutcome } from "./reaction-target";
import { reviewEventsFor, toNewReviewRecord, type ReviewerLabel } from "./records";
import { isTransient, withDeadline, withRetry, type RetryPolicy } from "./resilience";
import { renderResultReply, type ReplyPr } from "./result-reply";

export type ReviewConsumerConfig = {
  /** Lease per claim; extended before every step. */
  leaseMs: number;
  /** Upper bound on one LLM review call. Keep it below `leaseMs`. */
  reviewTimeoutMs: number;
  /** Upper bound on one GitHub call (the adapter also times out and retries reads). */
  githubTimeoutMs: number;
  /** Bounded retry of the Slack result reply. */
  reply: RetryPolicy;
};

export const DEFAULT_REVIEW_CONSUMER_CONFIG: ReviewConsumerConfig = {
  leaseMs: 15 * 60_000,
  reviewTimeoutMs: 10 * 60_000,
  githubTimeoutMs: 60_000,
  reply: { attempts: 3, baseMs: 1_000, maxMs: 30_000, timeoutMs: 15_000 },
};

export type ReviewConsumerDeps = {
  jobs: ReviewJobRepo;
  records: ReviewRecordRepo;
  events: ReviewEventRepo;
  threads: ThreadReviewIndex;
  uow: ReviewUnitOfWork;
  github: GitHubPort;
  reviewer: ReviewerSource;
  /** The stored repo list (`owner/repo`), the S2 allowlist. */
  repoList: () => Promise<readonly string[]>;
  /** Null when Slack is not configured: Slack jobs then get no reply (the backstop sends it later). */
  replier: ThreadReplier | null;
  /** The `/review/$reviewId` URL of a record. */
  reviewLink: (recordId: string) => string;
  reviewerLabel?: () => ReviewerLabel;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  timers: Timers;
  config?: Partial<ReviewConsumerConfig>;
};

export type ProcessOutcome =
  | { kind: "idle" }
  | { kind: "processed"; jobId: string; state: ReviewJobState }
  /** Another consumer took the job over (lease lost or version moved); nothing more was written. */
  | { kind: "abandoned"; jobId: string };

/** Thrown inside a run to stop it: the job is no longer ours to write. */
class LeaseLost extends Error {
  constructor(readonly reason: string) {
    super(`lease lost: ${reason}`);
  }
}

/** Thrown inside a run to end it with a state-machine event (interrupted / failed). */
class StopRun extends Error {
  constructor(readonly event: ReviewJobEvent) {
    super(event.type);
  }
}

type Run = {
  deps: ReviewConsumerDeps;
  cfg: ReviewConsumerConfig;
  owner: string;
  job: ReviewJob;
  log: Logger;
};

const cfgOf = (deps: ReviewConsumerDeps): ReviewConsumerConfig => ({
  ...DEFAULT_REVIEW_CONSUMER_CONFIG,
  ...deps.config,
});

/** Claims the oldest due job and runs it to a stop: terminal, requeued, or abandoned. */
export async function processNextReviewJob(
  deps: ReviewConsumerDeps,
  owner: string,
): Promise<ProcessOutcome> {
  const cfg = cfgOf(deps);
  const claimed = await deps.jobs.claimNext({ owner, leaseMs: cfg.leaseMs });
  if (!claimed) return { kind: "idle" };
  const run: Run = {
    deps,
    cfg,
    owner,
    job: claimed,
    log: deps.logger.child({ jobId: claimed.id, owner }),
  };
  try {
    // A reclaim that exhausted the interruptions (state-machine.ts D12): fail it, never run it.
    if (interruptionsExhausted(claimed)) await apply(run, { type: "interruption_limit" });
    else await runJob(run);
  } catch (error) {
    if (error instanceof LeaseLost) {
      run.log.warn("review job abandoned", { reason: error.reason });
      return { kind: "abandoned", jobId: claimed.id };
    }
    const event = error instanceof StopRun ? error.event : null;
    if (!event) run.log.error("review job crashed", { error: describe(error) });
    try {
      await apply(run, event ?? { type: "interrupted" });
    } catch (second) {
      // The lease expires and another consumer resumes from the checkpoints.
      run.log.error("review job could not be stopped cleanly", { error: describe(second) });
      return { kind: "abandoned", jobId: claimed.id };
    }
  }
  if (run.job.state === "done" || run.job.state === "failed") {
    await sendResultReply(deps, run.job);
  }
  return { kind: "processed", jobId: claimed.id, state: run.job.state };
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function runJob(run: Run): Promise<void> {
  for (const url of run.job.urls) {
    if (run.job.progress[url]?.completed) continue;
    await reviewUrl(run, url);
  }
  await apply(run, { type: "all_completed" });
}

async function keepLease(run: Run): Promise<void> {
  const held = await run.deps.jobs.extendLease(run.job.id, run.owner, run.cfg.leaseMs);
  if (!held) throw new LeaseLost("lease could not be extended");
}

function failWith(category: ReviewFailureCategory, error: string): never {
  throw new StopRun({ type: "failed", category, error });
}

/** Transient errors requeue the job (3 in a row fail it); anything else fails it now. */
function stopOn(e: DomainError, what: string): never {
  if (isTransient(e) || e.kind === "conflict" || e.kind === "deferred") {
    throw new StopRun({ type: "interrupted" });
  }
  const category: ReviewFailureCategory =
    e.kind === "not_configured"
      ? "not_configured"
      : e.kind === "validation" || e.kind === "not_found"
        ? "validation"
        : "upstream";
  failWith(category, `${what}: ${e.kind}`);
}

async function reviewUrl(run: Run, url: string): Promise<void> {
  const parsed = parsePrUrl(url);
  if (!parsed.ok) failWith("validation", "job url is not a PR URL");
  const ref = parsed.value;
  const gh = run.deps.github;
  const timeout = run.cfg.githubTimeoutMs;
  const timers = run.deps.timers;

  let p: UrlProgress = run.job.progress[url] ?? {};
  if (!p.review || !p.pr) {
    await keepLease(run);
    const diff = await withDeadline(timers, timeout, "github", () => gh.getDiff(ref));
    if (!diff.ok) stopOn(diff.error, "diff");
    if (!diff.value.complete) failWith("validation", "diff is incomplete");
    const meta = diff.value.meta;
    const pr: PrCheckpoint = {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: meta.title,
      author: meta.author,
      htmlUrl: meta.htmlUrl,
      base: meta.base,
      head: meta.head,
      sha: meta.sha,
      baseSha: meta.baseSha,
    };
    const reviewer = await run.deps.reviewer();
    if (!reviewer.ok) stopOn(reviewer.error, "reviewer");
    await keepLease(run);
    // The deadline aborts the in-flight LLM request through `signal`, not just abandons it.
    const result = await withDeadline(timers, run.cfg.reviewTimeoutMs, "llm", (signal) =>
      reviewer.value.review(
        {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          title: meta.title,
          body: meta.body,
          author: meta.author,
          base: meta.base,
          head: meta.head,
          diffText: buildReviewDiff(diff.value.files),
        },
        { signal },
      ),
    );
    if (!result.ok) stopOn(result.error, "review");
    await apply(run, {
      type: "checkpoint",
      url,
      patch: { pr, review: snapshot(result.value), reviewed: true },
    });
    p = run.job.progress[url]!;
  }
  const pr = p.pr!;
  const review = p.review!;
  const pass = reviewVerdict(review.findings) === "pass";

  if (!p.submitted) {
    await keepLease(run);
    const marker = commentMarker(run.job.id, url, pr.sha);
    const found = await withDeadline(timers, timeout, "github", () =>
      gh.findReviewByMarker(ref, marker, { commitId: pr.sha }),
    );
    if (!found.ok) stopOn(found.error, "find review");
    let id = found.value?.id;
    if (id === undefined) {
      const body = buildReviewCommentBody(review, {
        dedupeKey: markerKey(run.job.id, url, pr.sha),
      });
      const submitted = await withDeadline(timers, timeout, "github", () =>
        gh.submitReview(ref, {
          event: pass ? "COMMENT" : "REQUEST_CHANGES",
          body,
          commitId: pr.sha,
        }),
      );
      if (!submitted.ok) stopOn(submitted.error, "submit review");
      id = submitted.value.id;
    }
    await apply(run, {
      type: "checkpoint",
      url,
      patch: { commented: true, submitted: true, githubReviewId: id },
    });
    p = run.job.progress[url]!;
  }

  if (pass && (!p.approve || p.approve.step === "approve_pending")) {
    if (!p.approve) await apply(run, { type: "approve_started", url, sha: pr.sha });
    await keepLease(run);
    const outcome = await autoApprove(run, ref, url, pr);
    await apply(run, { type: "approve_finished", url, outcome });
  }
  await apply(run, { type: "url_completed", url });
}

const snapshot = (r: AiReviewResult): AiReviewResult => {
  const out: AiReviewResult = {
    summary: r.summary,
    findings: r.findings.map((f) => ({ ...f })),
    verificationRequests: [...r.verificationRequests],
  };
  if (r.summaryZh !== undefined) out.summaryZh = r.summaryZh;
  if (r.verificationRequestsZh !== undefined)
    out.verificationRequestsZh = [...r.verificationRequestsZh];
  return out;
};

const markerKey = (jobId: string, url: string, sha: string) =>
  createHash("sha256").update(`${jobId}:${url}:${sha}`).digest("hex");

function commentMarker(jobId: string, url: string, sha: string): string {
  const m = reviewCommentMarker(markerKey(jobId, url, sha));
  if (!m.ok) throw new Error("marker key is invalid");
  return m.value;
}

/** Marker of the auto-approve review, so a restarted run finds its own APPROVE. */
const approveMarker = (jobId: string, url: string, sha: string) =>
  `<!-- review-approve:${markerKey(jobId, url, sha)} -->`;

/**
 * FR-SHIP-01 auto-approve, pinned to the reviewed SHA. Never fails the job: every error becomes
 * `approve_failed` with a generic reason.
 */
async function autoApprove(
  run: Run,
  ref: PrRef,
  url: string,
  pr: PrCheckpoint,
): Promise<ApproveOutcome> {
  const { github: gh, timers } = run.deps;
  const t = run.cfg.githubTimeoutMs;
  const sha = pr.sha;
  const failed = (reason: string): ApproveOutcome => ({ step: "approve_failed", sha, reason });
  const marker = approveMarker(run.job.id, url, sha);

  // A restart after the APPROVE was submitted finds it instead of approving twice.
  const mine = await withDeadline(timers, t, "github", () =>
    gh.findReviewByMarker(ref, marker, { commitId: sha, state: "APPROVED" }),
  );
  if (!mine.ok) return failed(`github_${mine.error.kind}`);
  if (mine.value) return { step: "approved", sha, githubReviewId: mine.value.id };

  const meta = await withDeadline(timers, t, "github", () => gh.getPullRequest(ref));
  if (!meta.ok) return failed(`github_${meta.error.kind}`);
  const login = await withDeadline(timers, t, "github", () => gh.getAuthenticatedLogin());
  if (!login.ok) return failed(`github_${login.error.kind}`);
  let allowlist: readonly string[];
  let approvals: ApprovalRecord[];
  try {
    allowlist = await run.deps.repoList();
    approvals = await recordedApprovals(run.deps.events, url);
  } catch (error) {
    run.log.warn("auto-approve inputs unavailable", { error: describe(error) });
    return failed("store_unavailable");
  }
  let githubApprovedAtHead = false;
  if (meta.value.sha === sha) {
    const has = await withDeadline(timers, t, "github", () => gh.hasApproval(ref, sha));
    githubApprovedAtHead = has.ok && has.value;
  }
  const plan = autoApprovePlan({
    actor: { kind: "system" },
    repo: { owner: ref.owner, repo: ref.repo },
    allowlist,
    pr: {
      open: meta.value.state === "open",
      draft: meta.value.draft,
      merged: meta.value.merged,
      author: meta.value.author,
      headSha: meta.value.sha,
      baseSha: meta.value.baseSha,
    },
    authenticatedLogin: login.value,
    approvals,
    reviewedSha: sha,
    verdict: "pass",
    githubApprovedAtHead,
  });
  if (!plan.ok) return failed(`policy_${plan.error.kind}`);
  if (plan.value.kind === "skip")
    return { step: "approve_skipped", sha, reason: plan.value.reason };
  // Pinned to the REVIEWED sha (equal to the head the plan saw); a later push cannot move it.
  const submitted = await withDeadline(timers, t, "github", () =>
    gh.submitReview(ref, { event: "APPROVE", body: marker, commitId: sha }),
  );
  if (!submitted.ok) return failed(`github_${submitted.error.kind}`);
  return { step: "approved", sha, githubReviewId: submitted.value.id };
}

export async function recordedApprovals(
  events: ReviewEventRepo,
  prUrl: string,
): Promise<ApprovalRecord[]> {
  const rows = await events.list({ prUrl, types: ["approved", "force_approved"], limit: 100 });
  return rows
    .filter((e) => typeof e.sha === "string")
    .map((e) => ({ kind: e.type as ApprovalRecord["kind"], sha: e.sha! }))
    .toReversed();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Applies one event and persists it; the terminal transition goes through the unit of work. */
async function apply(run: Run, event: ReviewJobEvent): Promise<void> {
  const out = step(run.job, event, run.deps.clock.now());
  if (!out.ok) {
    // A rejected transition is a bug or a concurrent writer; never guess, stop writing.
    throw new LeaseLost(`transition ${event.type} rejected: ${out.error.kind}`);
  }
  const terminal = out.value.job.state === "done" || out.value.job.state === "failed";
  const saved = terminal
    ? await commitTerminal(run, out.value)
    : await run.deps.jobs.save(out.value.job, {
        expectedVersion: run.job.version,
        owner: run.owner,
      });
  if (!saved.ok) throw new LeaseLost(`save ${event.type}: ${saved.error.kind}`);
  run.job = saved.value;
}

function outcomeOf(job: ReviewJob, url: string): PrOutcome {
  const p = job.progress[url];
  if (job.state !== "done" || !p?.review) return "none";
  return reviewVerdict(p.review.findings);
}

/**
 * The single transaction of the terminal transition (FR-REVIEW-05, FR-SLACK-08): job, records,
 * events, thread index and reaction target. A reaction or thread-index problem is logged and
 * never blocks the review result.
 */
async function commitTerminal(run: Run, out: TransitionOutcome): Promise<Result<ReviewJob>> {
  const { deps } = run;
  const job = out.job;
  const label = deps.reviewerLabel?.() ?? {};
  const prepared: { domain: DomainRecord; id: string }[] = out.records.map((r) => ({
    domain: r,
    id: deps.ids.uuid(),
  }));
  const rows: NewReviewRecord[] = [];
  for (const { domain, id } of prepared) {
    const row = toNewReviewRecord(domain, id, label);
    if (!row.ok) return row;
    rows.push(row.value);
  }
  const events = prepared.flatMap(({ domain, id }) =>
    reviewEventsFor({
      record: domain,
      recordId: id,
      progress: job.progress[domain.prUrl] ?? {},
      newId: () => deps.ids.uuid(),
    }),
  );
  const slack = job.source === "slack" ? job.slack : undefined;
  const threadKey = slack ? { channel: slack.channel, threadTs: slack.threadTs ?? slack.ts } : null;
  // Other PRs of the thread keep their latest verdict in the message's aggregate (Q23).
  const others: PrOutcome[] = [];
  if (threadKey && out.intents.length > 0) {
    const thread = await deps.threads.get(threadKey);
    for (const prUrl of thread?.prUrls ?? []) {
      if (job.urls.includes(prUrl)) continue;
      const latest = await deps.records.latestForPr(prUrl);
      others.push(latest?.status === "completed" && latest.verdict ? latest.verdict : "none");
    }
  }

  return deps.uow.run(async (tx) => {
    const saved = await tx.saveJob(job, { expectedVersion: run.job.version, owner: run.owner });
    if (!saved.ok) return saved;
    for (const row of rows) {
      const inserted = await tx.insertRecord(row);
      if (!inserted.ok) return inserted;
    }
    for (const event of events) await tx.appendEvent(event);
    if (slack && threadKey && out.intents.length > 0 && prepared.length > 0) {
      const reviewId = prepared[0]!.id;
      const thread = slack.user
        ? await tx.recordThreadReview({
            ...threadKey,
            prUrls: job.urls,
            requesterSlackId: slack.user,
            reviewId,
            statusMessageTs: slack.ts,
          })
        : err<DomainError>({ kind: "validation", field: "user", message: "no requester" });
      if (!thread.ok) {
        run.log.warn("thread index not recorded; no reaction", { error: thread.error.kind });
      } else {
        const target = verdictTarget({
          channel: slack.channel,
          ts: slack.ts,
          prUrl: job.urls[0]!,
          round: thread.value.reviewSeq,
          reviewId,
          outcomes: [...job.urls.map((u) => outcomeOf(job, u)), ...others],
        });
        const enqueued = await tx.enqueueReaction(target);
        if (!enqueued.ok) run.log.warn("reaction not enqueued", { error: enqueued.error.kind });
      }
    }
    return ok(saved.value);
  });
}

// ---------------------------------------------------------------------------
// Result reply (FR-SLACK-08): at most once, then the backstop
// ---------------------------------------------------------------------------

/**
 * Sends the reply of a terminal Slack job once. `reply_sent` is saved (compare-and-set) BEFORE
 * the send, so concurrent senders cannot both post; a send that still fails after the bounded
 * retry is logged, never re-sent (AC 1: at most once).
 */
export async function sendResultReply(deps: ReviewConsumerDeps, job: ReviewJob): Promise<boolean> {
  if (job.source !== "slack" || !job.slack || job.resultReplySent) return false;
  if (job.state !== "done" && job.state !== "failed") return false;
  if (!deps.replier) return false;
  const log = deps.logger.child({ jobId: job.id });
  const marked = step(job, { type: "reply_sent" }, deps.clock.now());
  if (!marked.ok) return false;
  const saved = await deps.jobs.save(marked.value.job, { expectedVersion: job.version });
  if (!saved.ok) return false;

  const prs: ReplyPr[] = [];
  for (const prUrl of job.urls) {
    const page = await deps.records.list({ prUrl, limit: 20 });
    const mine = page.ok
      ? page.value.items.filter((r) => r.jobId === job.id).toSorted((a, b) => b.run - a.run)[0]
      : undefined;
    prs.push({ prUrl, recordId: mine?.id ?? null, failure: mine?.errorCategory ?? null });
  }
  const text = renderResultReply(job, prs, deps.reviewLink);
  const cfg = cfgOf(deps);
  const sent = await withRetry(deps.timers, cfg.reply, "slack", () =>
    deps.replier!.reply({
      channel: job.slack!.channel,
      threadTs: job.slack!.threadTs ?? job.slack!.ts,
      text,
    }),
  );
  if (!sent.ok) {
    log.error("result reply failed; not retried (at most once)", { error: sent.error.kind });
    return false;
  }
  return true;
}

/** Backstop: terminal Slack jobs whose reply was never sent (a crash after the commit). */
export async function sendPendingResultReplies(
  deps: ReviewConsumerDeps,
  opts: { limit: number } = { limit: 50 },
): Promise<number> {
  const recent = await deps.jobs.listRecent({ limit: opts.limit });
  let sent = 0;
  for (const job of recent) {
    if (job.source !== "slack" || job.resultReplySent) continue;
    if (job.state !== "done" && job.state !== "failed") continue;
    if (await sendResultReply(deps, job)) sent += 1;
  }
  return sent;
}
