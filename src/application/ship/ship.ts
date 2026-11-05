/**
 * Ship use cases (FR-SHIP-01..08): approve, force approve and merge one PR on behalf of a user.
 *
 * The decisions are the ship policy's (`domain/ship/policy`); this layer only gathers the inputs
 * (GitHub, the latest review record, the recorded approvals), carries out the one GitHub write,
 * and appends the matching `review_event` in the same transaction as any status emoji change.
 * Nothing here auto-merges: `mergePr` is only ever called for an explicit user command.
 */
import { parsePrUrl, type PrRef } from "../../domain/github/pr-ref";
import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import {
  approvePlan,
  forceApprovePlan,
  mergeGates,
  mergePlan,
  REFUSAL,
  type MergeGate,
  type MergeGateId,
  type MergeInput,
  type PrState,
  type ReviewAtSha,
  type Verdict,
} from "../../domain/ship/policy";
import { FORCE_APPROVED, PASSED } from "../../domain/slack/status-emoji";
import type {
  ChecksSummary,
  GitHubPort,
  MergeableState,
  MergeMethod,
  PullRequestMeta,
} from "../../ports/github";
import type { EventActor, NewReviewEvent, ReviewEventRepo } from "../../ports/review-event-repo";
import type { ReviewJobRepo } from "../../ports/review-job-repo";
import type { ReviewRecord, ReviewRecordRepo } from "../../ports/review-record-repo";
import type { Clock, IdGenerator, Logger } from "../../ports/system";
import type { ThreadReviewIndex } from "../../ports/thread-review-index";
import type { Timers, ReviewUnitOfWork } from "../review/ports";
import { forceApprovedTarget, mergedTarget } from "../review/reaction-target";
import { withDeadline } from "../review/resilience";
import { recordedApprovals } from "../review/review-job-consumer";

export type ShipDeps = {
  github: GitHubPort;
  records: ReviewRecordRepo;
  events: ReviewEventRepo;
  jobs: ReviewJobRepo;
  threads: ThreadReviewIndex;
  uow: ReviewUnitOfWork;
  /** Canonical `owner/repo` names of the stored repo list (the allowlist). */
  repoList: () => Promise<readonly string[]>;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  timers: Timers;
  /** Per GitHub call. The adapter retries on its own; this bounds the whole call. */
  githubTimeoutMs?: number;
  /** From config (3w wires it). Absent: the adapter's own preference order decides. */
  mergeMethod?: MergeMethod;
};

export type ShipRequest = { actor: Actor; prUrl: string; source: "web" | "slack" };

/**
 * A merge request. `expectedSha` is the head the caller showed the user (the /merge page): a
 * different live head is refused with `SHIP_REFUSAL.headMoved` before any write.
 */
export type MergeRequest = ShipRequest & { expectedSha?: string };

/** Refusal reasons of this layer, distinct from the policy's `REFUSAL` values. */
export const SHIP_REFUSAL = {
  mergeableUnknown:
    "GitHub has not finished checking whether the PR can be merged; try again shortly.",
  headMoved: "The PR head moved since it was shown; refresh and check again.",
} as const;

export type ApproveOutcome = {
  status: "approved" | "already_approved";
  sha: string;
  githubReviewId: number | null;
};

export type ForceApproveOutcome = {
  status: "force_approved" | "already_approved_by_review" | "already_force_approved";
  sha: string;
  /** The verdict the force approval overrode (only on `force_approved`). */
  overridden: Verdict | null;
  githubReviewId: number | null;
};

export type MergeOutcome =
  | { status: "merged"; sha: string; mergeSha: string; p0Waived: boolean; gates: MergeGate[] }
  | { status: "already_merged" };

/**
 * A refused or failed merge always carries the checklist so the caller can show what blocks.
 * `unknown` lists the gates whose GitHub lookup gave no answer (shown as "unknown", still failing).
 */
export type MergeFailure = { error: DomainError; gates: MergeGate[]; unknown?: MergeGateId[] };

/** The /merge row: every gate at the live head, read-only. */
export type MergeChecklist = {
  prUrl: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  /** Untrusted PR text from GitHub; render as plain text. */
  title: string;
  author: string;
  gates: MergeGate[];
  unknown: MergeGateId[];
  mergeable: boolean | null;
  mergeableState: MergeableState;
  /** `null` when the checks lookup failed. */
  checks: ChecksSummary | null;
  p0Waived: boolean;
  /** `mergePlan` passes for this actor right now. */
  canMerge: boolean;
  /** Why not, when `canMerge` is false (the first failing gate, or the lookup error). */
  blocked: DomainError | null;
};

const DEFAULT_GITHUB_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type Context = {
  ref: PrRef;
  meta: PullRequestMeta;
  pr: PrState;
  latest: ReviewRecord | null;
  latestReview: ReviewAtSha | null;
  allowlist: readonly string[];
};

const gh = <T>(deps: ShipDeps, call: () => Promise<Result<T>>) =>
  withDeadline(deps.timers, deps.githubTimeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS, "github", call);

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const eventActor = (actor: Actor): EventActor =>
  actor.kind === "user" ? { kind: "user", id: actor.userId } : { kind: "machine", id: actor.name };

async function loadContext(
  deps: ShipDeps,
  prUrl: string,
  options: { awaitMergeable?: boolean } = {},
): Promise<Result<Context>> {
  const ref = parsePrUrl(prUrl);
  if (!ref.ok) return ref;
  const meta = await gh(deps, () =>
    deps.github.getPullRequest(
      ref.value,
      options.awaitMergeable ? { awaitMergeable: true } : undefined,
    ),
  );
  if (!meta.ok) return meta;
  try {
    const [page, allowlist] = await Promise.all([
      deps.records.list({ prUrl: ref.value.url, status: "completed", limit: 1 }),
      deps.repoList(),
    ]);
    if (!page.ok) return page;
    const latest = page.value.items[0] ?? null;
    const m = meta.value;
    return ok({
      ref: ref.value,
      meta: m,
      pr: {
        open: m.state === "open",
        draft: m.draft,
        merged: m.merged,
        author: m.author,
        headSha: m.sha,
        baseSha: m.baseSha,
      },
      latest,
      latestReview:
        latest?.headSha && latest.verdict ? { sha: latest.headSha, verdict: latest.verdict } : null,
      allowlist,
    });
  } catch (error) {
    deps.logger.error("ship context unavailable", { prUrl, error: describe(error) });
    return err({ kind: "upstream", service: "github", retryable: true });
  }
}

/**
 * The Slack status message of the PR's latest review, when the emoji belongs to this PR alone.
 * A thread with several PRs shows the aggregate; ship emoji there would mislead (Q23).
 */
async function slackOrigin(
  deps: ShipDeps,
  latest: ReviewRecord | null,
): Promise<{ channel: string; ts: string; round: number; reviewId: string } | null> {
  if (!latest || latest.source !== "slack") return null;
  try {
    const job = await deps.jobs.get(latest.jobId);
    const slack = job?.slack;
    if (!slack) return null;
    const thread = await deps.threads.get({
      channel: slack.channel,
      threadTs: slack.threadTs ?? slack.ts,
    });
    if (!thread || thread.prUrls.length !== 1 || thread.reviewSeq < 1) return null;
    return {
      channel: thread.channel,
      ts: thread.statusMessageTs ?? slack.ts,
      round: thread.reviewSeq,
      reviewId: thread.latestReviewId ?? latest.id,
    };
  } catch (error) {
    deps.logger.warn("slack origin unavailable", { prUrl: latest.prUrl, error: describe(error) });
    return null;
  }
}

function event(
  deps: ShipDeps,
  req: ShipRequest,
  ctx: Context,
  fields: Pick<NewReviewEvent, "type" | "sha"> & Partial<NewReviewEvent>,
): NewReviewEvent {
  return {
    id: deps.ids.uuid(),
    actor: eventActor(req.actor),
    at: deps.clock.now(),
    prUrl: ctx.ref.url,
    source: req.source,
    ...(ctx.latest ? { reviewId: ctx.latest.id } : {}),
    ...fields,
  };
}

async function login(deps: ShipDeps): Promise<Result<string>> {
  return gh(deps, () => deps.github.getAuthenticatedLogin());
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

/** `approve` (FR-SHIP-03): only after a passing review at the current head. No emoji change. */
export async function approvePr(deps: ShipDeps, req: ShipRequest): Promise<Result<ApproveOutcome>> {
  const ctx = await loadContext(deps, req.prUrl);
  if (!ctx.ok) return ctx;
  const { ref, pr } = ctx.value;
  const who = await login(deps);
  if (!who.ok) return who;
  const has = await gh(deps, () => deps.github.hasApproval(ref, pr.headSha));
  if (!has.ok) return has;
  const approvals = await recordedApprovals(deps.events, ref.url);
  const plan = approvePlan({
    actor: req.actor,
    repo: { owner: ref.owner, repo: ref.repo },
    allowlist: ctx.value.allowlist,
    pr,
    authenticatedLogin: who.value,
    approvals,
    latestReview: ctx.value.latestReview,
    githubApprovedAtHead: has.value,
  });
  if (!plan.ok) return plan;

  if (plan.value.kind === "noop") {
    // Approved on GitHub but never recorded (e.g. by hand): record it so merge sees it.
    if (!approvals.some((a) => a.sha === plan.value.sha)) {
      await appendOutside(
        deps,
        event(deps, req, ctx.value, {
          type: "approved",
          sha: plan.value.sha,
          reason: "reconciled: approved on GitHub",
        }),
      );
    }
    return ok({ status: "already_approved", sha: plan.value.sha, githubReviewId: null });
  }

  const sha = plan.value.sha;
  const submitted = await gh(deps, () =>
    deps.github.submitReview(ref, { event: "APPROVE", commitId: sha }),
  );
  if (!submitted.ok) {
    await appendOutside(
      deps,
      event(deps, req, ctx.value, {
        type: "approve_failed",
        sha,
        reason: `github_${submitted.error.kind}`,
      }),
    );
    return submitted;
  }
  const recorded = await deps.uow
    .run(async (tx) => {
      await tx.appendEvent(
        event(deps, req, ctx.value, {
          type: "approved",
          sha,
          detail: { githubReviewId: submitted.value.id },
        }),
      );
      return ok(undefined);
    })
    .catch((error: unknown): Result<void> => {
      deps.logger.error("approve event not recorded", { prUrl: ref.url, error: describe(error) });
      return ok(undefined);
    });
  if (!recorded.ok) return recorded;
  return ok({ status: "approved", sha, githubReviewId: submitted.value.id });
}

/** For history rows that must not turn a done GitHub write into a reported failure. */
async function appendOutside(deps: ShipDeps, e: NewReviewEvent): Promise<void> {
  try {
    await deps.events.append(e);
  } catch (error) {
    deps.logger.error("review event not recorded", { type: e.type, error: describe(error) });
  }
}

// ---------------------------------------------------------------------------
// Force approve
// ---------------------------------------------------------------------------

/**
 * `force approve` (FR-SHIP-06): approve at the current head despite the review; replaces 🔴 by 🟡
 * in the same transaction as the event. Never merges.
 */
export async function forceApprovePr(
  deps: ShipDeps,
  req: ShipRequest,
): Promise<Result<ForceApproveOutcome>> {
  const ctx = await loadContext(deps, req.prUrl);
  if (!ctx.ok) return ctx;
  const { ref, pr } = ctx.value;
  const who = await login(deps);
  if (!who.ok) return who;
  const approvals = await recordedApprovals(deps.events, ref.url);
  const plan = forceApprovePlan({
    actor: req.actor,
    repo: { owner: ref.owner, repo: ref.repo },
    allowlist: ctx.value.allowlist,
    pr,
    authenticatedLogin: who.value,
    approvals,
    latestReview: ctx.value.latestReview,
  });
  if (!plan.ok) return plan;
  if (plan.value.kind === "noop") {
    return ok({
      status: plan.value.reason,
      sha: plan.value.sha,
      overridden: null,
      githubReviewId: null,
    });
  }
  const { sha, overridden } = plan.value;

  // An APPROVED review already at this head (an earlier attempt that crashed) is reused.
  const existing = await gh(deps, () =>
    deps.github.findReviewByMarker(ref, "", { commitId: sha, state: "APPROVED" }),
  );
  if (!existing.ok) return existing;
  let reviewId = existing.value?.id ?? null;
  if (reviewId === null) {
    const submitted = await gh(deps, () =>
      deps.github.submitReview(ref, { event: "APPROVE", commitId: sha }),
    );
    if (!submitted.ok) {
      await appendOutside(
        deps,
        event(deps, req, ctx.value, {
          type: "approve_failed",
          sha,
          reason: `github_${submitted.error.kind}`,
        }),
      );
      return submitted;
    }
    reviewId = submitted.value.id;
  }

  const origin = await slackOrigin(deps, ctx.value.latest);
  const committed = await deps.uow
    .run(async (tx) => {
      await tx.appendEvent(
        event(deps, req, ctx.value, {
          type: "force_approved",
          sha,
          reason: `overrode ${overridden}`,
          detail: { githubReviewId: reviewId, overridden },
        }),
      );
      if (origin) {
        const queued = await tx.enqueueReaction(forceApprovedTarget({ ...origin, prUrl: ref.url }));
        if (!queued.ok)
          deps.logger.warn("🟡 not queued", { prUrl: ref.url, error: queued.error.kind });
      }
      return ok(undefined);
    })
    .catch((error: unknown): Result<void> => err(storeError(deps, ref.url, error)));
  if (!committed.ok) return committed;
  return ok({ status: "force_approved", sha, overridden, githubReviewId: reviewId });
}

function storeError(deps: ShipDeps, prUrl: string, error: unknown): DomainError {
  deps.logger.error("ship transaction failed", { prUrl, error: describe(error) });
  return { kind: "upstream", service: "github", retryable: true };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

type MergeFacts = {
  input: MergeInput;
  gates: MergeGate[];
  unknown: MergeGateId[];
  checks: Result<ChecksSummary>;
};

/** Live checks and recorded approvals at the current head, folded into the policy input. */
async function mergeFacts(deps: ShipDeps, actor: Actor, ctx: Context): Promise<MergeFacts> {
  const { ref, pr, meta } = ctx;
  const [checks, approvals] = await Promise.all([
    gh(deps, () => deps.github.getChecks({ owner: ref.owner, repo: ref.repo }, pr.headSha)),
    recordedApprovals(deps.events, ref.url),
  ]);
  const input: MergeInput = {
    actor,
    repo: { owner: ref.owner, repo: ref.repo },
    allowlist: ctx.allowlist,
    pr,
    latestReview: ctx.latestReview,
    approvals,
    checksGreen: checks.ok && checks.value.state === "green",
    // `null` (GitHub still computing after the bounded re-reads) fails the gate.
    mergeable: meta.mergeable,
  };
  const unknown: MergeGateId[] = [];
  if (!checks.ok) unknown.push("checks_green");
  if (meta.mergeable === null) unknown.push("mergeable");
  return { input, gates: mergeGates(input), unknown, checks };
}

/** The policy decision, with an unknown mergeable reported as such rather than "not mergeable". */
function decideMerge(facts: MergeFacts) {
  const plan = mergePlan(facts.input);
  if (
    !plan.ok &&
    plan.error.kind === "conflict" &&
    plan.error.reason === REFUSAL.notMergeable &&
    facts.input.mergeable === null
  ) {
    return err<DomainError>({ kind: "conflict", reason: SHIP_REFUSAL.mergeableUnknown });
  }
  return plan;
}

const lowerSha = (sha: string | undefined) => sha?.trim().toLowerCase();

/**
 * The /merge checklist for one PR (FR-SHIP-05): the same facts and policy as `mergePr`, at the
 * live head, waiting a bounded time for GitHub's mergeable flag. Never writes.
 */
export async function mergeChecklist(
  deps: ShipDeps,
  req: { actor: Actor; prUrl: string },
): Promise<Result<MergeChecklist>> {
  const ctx = await loadContext(deps, req.prUrl, { awaitMergeable: true });
  if (!ctx.ok) return ctx;
  const { meta, pr } = ctx.value;
  const facts = await mergeFacts(deps, req.actor, ctx.value);
  const plan = decideMerge(facts);
  // A checks lookup that failed reads as "not green"; report the lookup failure instead.
  const checksUnread =
    !plan.ok &&
    !facts.checks.ok &&
    plan.error.kind === "conflict" &&
    plan.error.reason === REFUSAL.checksNotGreen;
  const blocked = plan.ok
    ? null
    : checksUnread && !facts.checks.ok
      ? facts.checks.error
      : plan.error;
  return ok({
    prUrl: ctx.value.ref.url,
    headSha: pr.headSha,
    state: pr.merged ? "merged" : pr.open ? "open" : "closed",
    draft: pr.draft,
    title: meta.title,
    author: meta.author,
    gates: facts.gates,
    unknown: facts.unknown,
    mergeable: meta.mergeable,
    mergeableState: meta.mergeableState,
    checks: facts.checks.ok ? facts.checks.value : null,
    p0Waived: facts.gates.some((g) => g.id === "no_p0" && g.status === "waived"),
    canMerge: blocked === null,
    blocked,
  });
}

/**
 * `merge` (FR-SHIP-05, FR-SHIP-08): every gate must pass at the current head; the merge call is
 * pinned to that head so GitHub rejects a head that moved in between. A refusal returns the
 * checklist. ✅ is queued with the `merged` event only after GitHub confirmed the merge.
 */
export async function mergePr(
  deps: ShipDeps,
  req: MergeRequest,
): Promise<Result<MergeOutcome, MergeFailure>> {
  const ctx = await loadContext(deps, req.prUrl, { awaitMergeable: true });
  if (!ctx.ok) return err({ error: ctx.error, gates: [] });
  const { ref, pr } = ctx.value;
  if (pr.merged) return ok({ status: "already_merged" });

  const facts = await mergeFacts(deps, req.actor, ctx.value);
  const { gates, unknown } = facts;
  const expected = lowerSha(req.expectedSha);
  if (expected !== undefined && expected !== lowerSha(pr.headSha)) {
    return err({ error: { kind: "conflict", reason: SHIP_REFUSAL.headMoved }, gates, unknown });
  }
  if (!facts.checks.ok) return err({ error: facts.checks.error, gates, unknown });
  const plan = decideMerge(facts);
  if (!plan.ok) return err({ error: plan.error, gates, unknown });

  const { sha, p0Waived } = plan.value;
  const merged = await gh(deps, () =>
    deps.github.merge(ref, {
      sha,
      ...(deps.mergeMethod ? { method: deps.mergeMethod } : {}),
    }),
  );
  if (!merged.ok) {
    await appendOutside(
      deps,
      event(deps, req, ctx.value, {
        type: "merge_failed",
        sha,
        reason: `github_${merged.error.kind}`,
      }),
    );
    return err({ error: merged.error, gates });
  }

  const origin = await slackOrigin(deps, ctx.value.latest);
  const committed = await deps.uow
    .run(async (tx) => {
      await tx.appendEvent(
        event(deps, req, ctx.value, {
          type: "merged",
          sha,
          detail: { mergeSha: merged.value.sha, p0Waived },
        }),
      );
      if (origin) {
        const status = p0Waived ? FORCE_APPROVED : PASSED;
        const queued = await tx.enqueueReaction(
          mergedTarget({ ...origin, prUrl: ref.url, status }),
        );
        if (!queued.ok)
          deps.logger.warn("✅ not queued", { prUrl: ref.url, error: queued.error.kind });
      }
      return ok(undefined);
    })
    .catch((error: unknown): Result<void> => {
      // GitHub merged: the merge is reported as done even if its history row could not be written.
      deps.logger.error("merged event not recorded", { prUrl: ref.url, error: describe(error) });
      return ok(undefined);
    });
  if (!committed.ok) deps.logger.error("merged event not recorded", { prUrl: ref.url });
  return ok({ status: "merged", sha, mergeSha: merged.value.sha, p0Waived, gates });
}
