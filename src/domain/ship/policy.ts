import { err, ok, type DomainError, type Result } from "../shared/result";
import type { Actor } from "../shared/actor";
import { decideGithubEvent } from "../review/review";
import type { AiReviewResult, Finding, GithubReviewEvent } from "../review/types";

/**
 * ShipPolicy (architecture.md §4.2, requirements FR-SHIP-01..06). Pure functions over plain data;
 * every use case calls one of them before any GitHub write.
 *
 * - There is no `ship` mode: no path approves and merges in one step.
 * - `autoApprovePlan` is the only way to approve without a user, and only for the system actor.
 * - `approvePlan` and `forceApprovePlan` never merge.
 * - `mergePlan` never approves, and needs an approval recorded for the CURRENT head SHA.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The review pipeline acting on the owner's behalf. Only `autoApprovePlan` accepts it. */
export type SystemActor = { kind: "system" };
export type PolicyActor = Actor | SystemActor;

export type RepoRef = { owner: string; repo: string };

export type PrState = {
  open: boolean;
  draft: boolean;
  merged: boolean;
  author: string;
  headSha: string;
  baseSha: string;
};

export type Verdict = "pass" | "changes_requested";

/** The latest recorded review of the PR and the head SHA it reviewed. */
export type ReviewAtSha = { sha: string; verdict: Verdict };

/** A recorded `approved` or `force_approved` event (FR-REVIEW-06). */
export type ApprovalRecord = { kind: "approved" | "force_approved"; sha: string };

type PrContext = {
  actor: PolicyActor;
  repo: RepoRef;
  /** `owner/repo` entries from the stored repo list. Exact, case-insensitive; empty denies all. */
  allowlist: readonly string[];
  pr: PrState;
};

type ApproveContext = PrContext & {
  /** Login of the connected GitHub account that would approve (self-approval guard). */
  authenticatedLogin: string;
  approvals: readonly ApprovalRecord[];
};

// ---------------------------------------------------------------------------
// Refusal reasons
// ---------------------------------------------------------------------------

/**
 * Every refusal reason, one per gate, so callers render user-facing text from a constant rather
 * than by parsing a message. All values are distinct (FR-SHIP-05 AC1).
 */
export const REFUSAL = {
  invalidInput: "Policy input could not be read.",
  ownerOnly: "Only the owner can do this.",
  systemOnly: "Only the review pipeline can auto-approve.",
  repoNotAllowed: "Repository is not in your repo list.",
  merged: "PR is already merged.",
  closed: "PR is closed.",
  draft: "PR is a draft.",
  ownPr: "Cannot approve your own PR.",
  noReview: "No review on record for this PR.",
  staleReview: "New commits since review, re-review needed.",
  changesRequested: "The latest review requested changes; use `force approve` to override.",
  notApproved: "Approve (or force approve) first.",
  staleApproval: "New commits since approval, re-review needed.",
  staleForceApproval: "New commits since force approve, re-review needed.",
  p0: "The latest review has a P0 finding.",
  checksNotGreen: "Required checks are not green.",
  notMergeable: "GitHub does not report the PR as mergeable.",
} as const;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

type Refusal = { ok: false; error: DomainError };
const forbidden = (reason: string): Refusal => err({ kind: "forbidden", reason });
const conflict = (reason: string): Refusal => err({ kind: "conflict", reason });
const invalid = (message: string, field?: string): Refusal =>
  err({ kind: "validation", ...(field ? { field } : {}), message });

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** `owner/repo` with two non-empty, whitespace- and wildcard-free parts, lowercase; else null. */
function normaliseEntry(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const parts = entry.trim().toLowerCase().split("/");
  if (parts.length !== 2) return null;
  if (parts.some((p) => p === "" || /[\s*?]/.test(p))) return null;
  return `${parts[0]}/${parts[1]}`;
}

function repoKeyOf(repo: RepoRef | undefined): string | null {
  if (!repo || typeof repo.owner !== "string" || typeof repo.repo !== "string") return null;
  if (repo.owner.includes("/") || repo.repo.includes("/")) return null;
  return normaliseEntry(`${repo.owner}/${repo.repo}`);
}

/** S2. Fails closed on an empty or missing list, a malformed repo and malformed entries. */
export function isRepoAllowed(repo: RepoRef, allowlist: readonly string[] | undefined): boolean {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const key = repoKeyOf(repo);
  if (key === null) return false;
  return allowlist.some((entry) => normaliseEntry(entry) === key);
}

/** Lowercase full SHA, or null when it is not a 40- or 64-hex string. */
function normSha(sha: unknown): string | null {
  return typeof sha === "string" && SHA_RE.test(sha) ? sha.toLowerCase() : null;
}

function prStateRefusal(pr: PrState): Refusal | null {
  if (pr.merged) return conflict(REFUSAL.merged);
  if (!pr.open) return conflict(REFUSAL.closed);
  if (pr.draft) return conflict(REFUSAL.draft);
  return null;
}

function isOwnPr(pr: PrState, login: string): boolean {
  return typeof pr.author === "string" && pr.author.trim().toLowerCase() === login.toLowerCase();
}

function loginOf(input: { authenticatedLogin?: unknown }): string | null {
  const login = typeof input.authenticatedLogin === "string" ? input.authenticatedLogin.trim() : "";
  return login || null;
}

/** Approvals with a well-formed SHA, normalised; anything malformed is dropped (never counts). */
function approvalsOf(input: {
  approvals?: unknown;
}): { kind: ApprovalRecord["kind"]; sha: string }[] {
  if (!Array.isArray(input.approvals)) return [];
  const out: { kind: ApprovalRecord["kind"]; sha: string }[] = [];
  for (const a of input.approvals as unknown[]) {
    if (!a || typeof a !== "object") continue;
    const { kind, sha } = a as { kind?: unknown; sha?: unknown };
    const s = normSha(sha);
    if (s && (kind === "approved" || kind === "force_approved")) out.push({ kind, sha: s });
  }
  return out;
}

function reviewOf(input: {
  latestReview?: unknown;
}): { sha: string | null; verdict: unknown } | null {
  const r = input.latestReview;
  if (!r || typeof r !== "object") return null;
  const { sha, verdict } = r as { sha?: unknown; verdict?: unknown };
  return { sha: normSha(sha), verdict };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** Runs a policy body; any unexpected read of malformed input fails closed instead of throwing. */
function guarded<T>(input: unknown, body: () => Result<T, DomainError>): Result<T, DomainError> {
  try {
    if (!isObject(input)) return invalid("Missing input.");
    if (!isObject(input.pr)) return invalid("Missing PR state.", "pr");
    return body();
  } catch {
    return invalid(REFUSAL.invalidInput);
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type ReviewVerdict = {
  verdict: Verdict;
  event: GithubReviewEvent;
  /** Findings that block a pass: any P0 or unknown severity. */
  blockingCount: number;
};

/**
 * Review verdict only (FR-SHIP-01): any P0, or any finding whose severity is not a known
 * non-blocking one, requests changes; otherwise the review passes. It decides nothing about
 * approving or merging. A review that cannot be read is never a pass.
 */
export function mergeDecision(review: AiReviewResult): Result<ReviewVerdict, DomainError> {
  try {
    const findings = isObject(review) && Array.isArray(review.findings) ? review.findings : null;
    if (findings === null) return invalid("Review result is missing.", "review");
    const blockingCount = findings.filter(
      (f: Finding) => decideGithubEvent([f]) === "REQUEST_CHANGES",
    ).length;
    const pass = blockingCount === 0;
    return ok({
      verdict: pass ? "pass" : "changes_requested",
      event: pass ? "APPROVE" : "REQUEST_CHANGES",
      blockingCount,
    });
  } catch {
    return invalid("Review result could not be read.", "review");
  }
}

// ---------------------------------------------------------------------------
// autoApprovePlan
// ---------------------------------------------------------------------------

export type AutoApproveInput = ApproveContext & {
  /** The head SHA the review ran against. */
  reviewedSha: string;
  verdict: Verdict;
  /** GitHub already has an APPROVE by the connected account on this commit. */
  githubApprovedAtHead?: boolean;
};

export type AutoApproveSkipReason =
  | "not_passed"
  | "repo_not_allowed"
  | "pr_merged"
  | "pr_closed"
  | "pr_draft"
  | "own_pr"
  | "sha_changed"
  | "already_approved";

export type AutoApprovePlan =
  | { kind: "approve"; sha: string }
  | { kind: "skip"; reason: AutoApproveSkipReason };

const skip = (reason: AutoApproveSkipReason): Result<AutoApprovePlan, DomainError> =>
  ok({ kind: "skip", reason });

/**
 * Auto-approve after a review (FR-SHIP-01). System actor only (anything else is `forbidden`).
 * A gate that does not hold is a `skip(reason)`, which the use case records as
 * `approve_skipped`; malformed SHAs or an unknown login are `validation` errors (fail closed).
 */
export function autoApprovePlan(input: AutoApproveInput): Result<AutoApprovePlan, DomainError> {
  return guarded<AutoApprovePlan>(input, () => {
    if (input.actor?.kind !== "system") return forbidden(REFUSAL.systemOnly);
    if (input.verdict !== "pass") return skip("not_passed");
    if (!isRepoAllowed(input.repo, input.allowlist)) return skip("repo_not_allowed");
    const pr = input.pr;
    if (pr.merged) return skip("pr_merged");
    if (!pr.open) return skip("pr_closed");
    if (pr.draft) return skip("pr_draft");
    const head = normSha(pr.headSha);
    if (!head) return invalid("PR head SHA is missing or malformed.", "headSha");
    const reviewed = normSha(input.reviewedSha);
    if (!reviewed) return invalid("Reviewed SHA is missing or malformed.", "reviewedSha");
    const login = loginOf(input);
    if (!login) return invalid("Authenticated GitHub login is unknown.", "authenticatedLogin");
    if (isOwnPr(pr, login)) return skip("own_pr");
    if (reviewed !== head) return skip("sha_changed");
    if (input.githubApprovedAtHead === true || approvalsOf(input).some((a) => a.sha === head)) {
      return skip("already_approved");
    }
    return ok({ kind: "approve", sha: head });
  });
}

// ---------------------------------------------------------------------------
// approvePlan (owner `approve`, the manual retry)
// ---------------------------------------------------------------------------

export type ApproveInput = ApproveContext & {
  latestReview: ReviewAtSha | null;
  githubApprovedAtHead?: boolean;
};

export type ApprovePlan =
  | { kind: "approve"; sha: string }
  | { kind: "noop"; reason: "already_approved"; sha: string };

/** Shared front gates of the owner approve paths: actor, allowlist, PR state, own PR, SHA, login. */
function ownerApproveGates(input: ApproveContext): Result<{ head: string }, DomainError> {
  if (input.actor?.kind !== "user") return forbidden(REFUSAL.ownerOnly);
  if (!isRepoAllowed(input.repo, input.allowlist)) return forbidden(REFUSAL.repoNotAllowed);
  const state = prStateRefusal(input.pr);
  if (state) return state;
  const head = normSha(input.pr.headSha);
  if (!head) return invalid("PR head SHA is missing or malformed.", "headSha");
  const login = loginOf(input);
  if (!login) return invalid("Authenticated GitHub login is unknown.", "authenticatedLogin");
  if (isOwnPr(input.pr, login)) return forbidden(REFUSAL.ownPr);
  return ok({ head });
}

/**
 * Owner `approve` (FR-SHIP-04). Already approved (normal or forced) at the head SHA → `noop`.
 * Otherwise the latest review must be for the current head and must have passed; a red review
 * points to `force approve`, a stale one asks for a re-review.
 */
export function approvePlan(input: ApproveInput): Result<ApprovePlan, DomainError> {
  return guarded<ApprovePlan>(input, () => {
    const gates = ownerApproveGates(input);
    if (!gates.ok) return gates;
    const { head } = gates.value;
    if (input.githubApprovedAtHead === true || approvalsOf(input).some((a) => a.sha === head)) {
      return ok({ kind: "noop", reason: "already_approved", sha: head });
    }
    const latest = reviewOf(input);
    if (!latest) return conflict(REFUSAL.noReview);
    if (latest.sha !== head) return conflict(REFUSAL.staleReview);
    if (latest.verdict !== "pass") return conflict(REFUSAL.changesRequested);
    return ok({ kind: "approve", sha: head });
  });
}

// ---------------------------------------------------------------------------
// forceApprovePlan (owner `force approve`, Slack only, approve only)
// ---------------------------------------------------------------------------

export type ForceApproveInput = ApproveContext & { latestReview: ReviewAtSha | null };

export type ForceApprovePlan =
  /** Submit one APPROVE at `sha` and record `force_approved`, which waives the P0 merge gate. */
  | { kind: "approve_only"; sha: string; overridden: Verdict }
  | { kind: "noop"; reason: "already_approved_by_review" | "already_force_approved"; sha: string };

/**
 * Owner `force approve` (FR-SHIP-06). Never merges. Requires a review of the current head, so a
 * force approval can never cover unreviewed commits. A passing latest review → "already approved
 * by review" (use `approve`); an existing force approval at this SHA → `noop`.
 */
export function forceApprovePlan(input: ForceApproveInput): Result<ForceApprovePlan, DomainError> {
  return guarded<ForceApprovePlan>(input, () => {
    const gates = ownerApproveGates(input);
    if (!gates.ok) return gates;
    const { head } = gates.value;
    const latest = reviewOf(input);
    if (!latest) return conflict(REFUSAL.noReview);
    if (latest.sha !== head) return conflict(REFUSAL.staleReview);
    if (latest.verdict === "pass") {
      return ok({ kind: "noop", reason: "already_approved_by_review", sha: head });
    }
    if (approvalsOf(input).some((a) => a.kind === "force_approved" && a.sha === head)) {
      return ok({ kind: "noop", reason: "already_force_approved", sha: head });
    }
    return ok({ kind: "approve_only", sha: head, overridden: "changes_requested" });
  });
}

// ---------------------------------------------------------------------------
// mergeGates / mergePlan
// ---------------------------------------------------------------------------

export type MergeInput = PrContext & {
  latestReview: ReviewAtSha | null;
  /** Recorded events only; GitHub's reviewDecision alone is not an approval here. */
  approvals: readonly ApprovalRecord[];
  checksGreen: boolean;
  /** GitHub's `mergeable`; `null` (still computing) is not mergeable. */
  mergeable: boolean | null;
};

export type MergeGateId =
  | "allowlist"
  | "open"
  | "not_draft"
  | "approved_at_sha"
  | "no_p0"
  | "checks_green"
  | "mergeable";

export type MergeGateStatus = "pass" | "fail" | "waived";
export type MergeGate = { id: MergeGateId; status: MergeGateStatus };

export type MergePlan = {
  merge: true;
  /** The current head SHA; the merge call passes it so GitHub rejects a moved head. */
  sha: string;
  /** The no-P0 gate was waived by a force approval at this SHA. */
  p0Waived: boolean;
  gates: MergeGate[];
};

const GATE_ORDER: readonly MergeGateId[] = [
  "allowlist",
  "open",
  "not_draft",
  "approved_at_sha",
  "no_p0",
  "checks_green",
  "mergeable",
];

const allFailed = (): MergeGate[] => GATE_ORDER.map((id) => ({ id, status: "fail" }));

/**
 * The /merge checklist (FR-SHIP-05), in a fixed order. Actor-independent so the page can render
 * it; `mergePlan` adds the actor gate. Never throws: unreadable input fails every gate.
 */
export function mergeGates(input: Omit<MergeInput, "actor">): MergeGate[] {
  try {
    if (!isObject(input) || !isObject(input.pr)) return allFailed();
    const pr = input.pr;
    const head = normSha(pr.headSha);
    const approvals = approvalsOf(input);
    const atHead = head !== null && approvals.some((a) => a.sha === head);
    const forcedAtHead =
      head !== null && approvals.some((a) => a.kind === "force_approved" && a.sha === head);
    const latest = reviewOf(input);
    const passAtHead = head !== null && latest?.sha === head && latest.verdict === "pass";
    const status: Record<MergeGateId, MergeGateStatus> = {
      allowlist: isRepoAllowed(input.repo, input.allowlist) ? "pass" : "fail",
      open: pr.open === true && pr.merged !== true ? "pass" : "fail",
      not_draft: pr.draft === false ? "pass" : "fail",
      approved_at_sha: atHead ? "pass" : "fail",
      no_p0: passAtHead ? "pass" : forcedAtHead ? "waived" : "fail",
      checks_green: input.checksGreen === true ? "pass" : "fail",
      mergeable: input.mergeable === true ? "pass" : "fail",
    };
    return GATE_ORDER.map((id) => ({ id, status: status[id] }));
  } catch {
    return allFailed();
  }
}

/**
 * Merge (FR-SHIP-05). User actors only: machine and system actors are always `forbidden`. Never
 * approves. Fails on the first gate in checklist order, each with a distinct reason.
 */
export function mergePlan(input: MergeInput): Result<MergePlan, DomainError> {
  return guarded<MergePlan>(input, () => {
    if (input.actor?.kind !== "user") return forbidden(REFUSAL.ownerOnly);
    const pr = input.pr;
    const gates = mergeGates(input);
    const s = Object.fromEntries(gates.map((g) => [g.id, g.status])) as Record<
      MergeGateId,
      MergeGateStatus
    >;
    if (s.allowlist === "fail") return forbidden(REFUSAL.repoNotAllowed);
    if (s.open === "fail") return conflict(pr.merged ? REFUSAL.merged : REFUSAL.closed);
    if (s.not_draft === "fail") return conflict(REFUSAL.draft);
    const head = normSha(pr.headSha);
    if (!head) return invalid("PR head SHA is missing or malformed.", "headSha");
    if (s.approved_at_sha === "fail") {
      const older = approvalsOf(input).at(-1);
      if (!older) return conflict(REFUSAL.notApproved);
      return conflict(
        older.kind === "force_approved" ? REFUSAL.staleForceApproval : REFUSAL.staleApproval,
      );
    }
    if (s.no_p0 === "fail") {
      const latest = reviewOf(input);
      if (!latest) return conflict(REFUSAL.noReview);
      return conflict(latest.sha === head ? REFUSAL.p0 : REFUSAL.staleReview);
    }
    if (s.checks_green === "fail") return conflict(REFUSAL.checksNotGreen);
    if (s.mergeable === "fail") return conflict(REFUSAL.notMergeable);
    return ok({ merge: true, sha: head, p0Waived: s.no_p0 === "waived", gates });
  });
}
