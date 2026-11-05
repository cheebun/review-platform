import { z } from "zod";
import { getGithubAvailability, resolveGithubToken } from "../application/settings/view";
import { mergeChecklist, mergePr, SHIP_REFUSAL, type MergeFailure } from "../application/ship/ship";
import { parsePrUrl, type PrRef } from "../domain/github/pr-ref";
import type { Actor } from "../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../domain/shared/result";
import { isRepoAllowed, REFUSAL, type MergeGate, type MergeGateId } from "../domain/ship/policy";
import type { ChecksState, GitHubPort, MergeableState } from "../ports/github";
import type { ReviewEventRecord, ReviewEventRepo } from "../ports/review-event-repo";
import type { ReviewRecord, ReviewRecordRepo } from "../ports/review-record-repo";
import type { Ports } from "../server/container";
import { toHttp, unexpectedToHttp } from "../server/errors";
import type { FnResult } from "./fn-result";

/*
 * Server-only logic behind src/functions/merge.ts: the /merge page (FR-SHIP-05). The queue of
 * reviewed PRs awaiting merge, each PR's live gate checklist, the Merge action (the only web
 * action) and the merge history. Gate decisions are `application/ship`'s; this module resolves
 * the GitHub token, applies the repo list, and turns results into JSON-safe views.
 *
 * S4: GitHub's own text never leaves the server. A refusal is a fixed `RefusalCode`; any other
 * failure is `toHttp`'s fixed message with a request id that matches a log line.
 */

/**
 * What this module needs. Field names match the container's `Ports`: `githubClient` builds a
 * `GitHubPort` over the stored token per request (the token can change), `shipDeps` the ship
 * use-case deps over it.
 */
export type MergeDeps = Pick<
  Ports,
  | "ids"
  | "logger"
  | "githubRepos"
  | "reviewEvents"
  | "githubCredentials"
  | "tokenCipher"
  | "rateLimiter"
  | "reviewRecords"
  | "githubClient"
  | "shipDeps"
>;

/** Per user, sliding window (S6 style; the limiter fails closed). */
export const MERGE_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

// ---- Input validation ----

const MAX_URL = 500;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const gatesSchema = z.strictObject({ prUrl: z.string().min(1).max(MAX_URL) });
const mergeSchema = z.strictObject({
  prUrl: z.string().min(1).max(MAX_URL),
  expectedSha: z.string().regex(SHA_RE),
});
const historySchema = z.strictObject({ limit: z.number().int().min(1).max(100).optional() });

export type MergeGatesInput = z.infer<typeof gatesSchema>;
export type MergeInput = z.infer<typeof mergeSchema>;
export type MergeHistoryInput = z.infer<typeof historySchema>;

/** Validators throw a fixed message on a malformed shape; they never echo the input. */
function parser<T>(schema: z.ZodType<T>, what: string) {
  return (input: unknown): T => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid ${what}.`);
    return parsed.data;
  };
}

export const parseMergeGatesInput = parser(gatesSchema, "merge gates request");
export const parseMergeInput = parser(mergeSchema, "merge request");
export const parseMergeHistoryInput = (input: unknown): MergeHistoryInput =>
  parser(historySchema, "merge history request")(input === undefined ? {} : input);

// ---- Views (JSON-safe: dates are ISO strings) ----

export type GithubState = "ready" | "not_configured" | "needs_reset" | "no_repos";

export type MergeQueueItem = {
  prUrl: string;
  /** `owner/repo`. */
  repo: string;
  number: number;
  reviewId: string;
  reviewedSha: string | null;
  shortSha: string | null;
  verdict: "pass" | "changes_requested" | null;
  /** A `force_approved` event at the reviewed head: the P0 gate is waived ("P0 overridden"). */
  forceApproved: boolean;
  reviewedAt: string;
  source: "slack" | "web";
  /** Untrusted PR text from GitHub, null when GitHub could not be read. Render as plain text. */
  title: string | null;
  author: string | null;
};

export type MergeQueueView = { github: GithubState; items: MergeQueueItem[] };

/** `unknown`: GitHub gave no answer for this gate (still failing). */
export type GateStatusView = "pass" | "fail" | "waived" | "unknown";
export type GateView = { id: MergeGateId; status: GateStatusView };

/** Why a merge is blocked or was refused. Mapped to fixed text by the page. */
export type RefusalCode =
  | Exclude<keyof typeof REFUSAL, "invalidInput" | "systemOnly" | "ownPr">
  | keyof typeof SHIP_REFUSAL
  | "githubRejected"
  | "checksUnavailable"
  | "unavailable";

export type MergeGatesView = {
  prUrl: string;
  headSha: string;
  shortSha: string;
  state: "open" | "closed" | "merged";
  gates: GateView[];
  canMerge: boolean;
  blockedReason: RefusalCode | null;
  mergeableState: MergeableState;
  /** Check names are untrusted text. `null` when the checks lookup failed. */
  checks: { state: ChecksState; failing: string[]; pending: string[] } | null;
  p0Waived: boolean;
};

export type MergeOutcomeView =
  | { status: "merged"; sha: string; mergeSha: string; p0Waived: boolean }
  | { status: "already_merged" }
  | {
      status: "refused";
      reason: RefusalCode;
      /** The page should refetch the PR's gates and ask again. */
      headMoved: boolean;
      gates: GateView[];
      requestId: string;
    };

export type MergeHistoryItem = {
  id: string;
  prUrl: string;
  repo: string | null;
  number: number | null;
  /** The head SHA that was merged. */
  sha: string | null;
  mergeSha: string | null;
  actor: { kind: "user" | "machine" | "system"; id: string; self: boolean };
  source: "web" | "slack" | "system" | null;
  at: string;
  reviewId: string | null;
};

export type MergeHistoryView = { items: MergeHistoryItem[]; hasMore: boolean };

// ---- Helpers ----

const QUEUE_MAX = 50;
const RECORD_PAGE = 100;
const MAX_SCAN_PAGES = 5;
const CONCURRENCY = 6;
const HISTORY_DEFAULT = 20;
const PR_EVENT_LIMIT = 50;

const shortSha = (sha: string | undefined | null) => (sha ? sha.slice(0, 7) : null);

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>) {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function allowlist(deps: MergeDeps): Promise<string[]> {
  return (await deps.githubRepos.listRepos()).map((r) => r.canonical);
}

/** The stored token's `GitHubPort`, or `not_configured`. The token never leaves this function. */
async function github(deps: MergeDeps): Promise<Result<GitHubPort>> {
  const token = await resolveGithubToken(deps);
  if (!token.ok) return token;
  return ok(deps.githubClient(token.value));
}

const REFUSAL_CODES = new Map<string, RefusalCode>([
  [REFUSAL.ownerOnly, "ownerOnly"],
  [REFUSAL.repoNotAllowed, "repoNotAllowed"],
  [REFUSAL.merged, "merged"],
  [REFUSAL.closed, "closed"],
  [REFUSAL.draft, "draft"],
  [REFUSAL.noReview, "noReview"],
  [REFUSAL.staleReview, "staleReview"],
  [REFUSAL.changesRequested, "changesRequested"],
  [REFUSAL.notApproved, "notApproved"],
  [REFUSAL.staleApproval, "staleApproval"],
  [REFUSAL.staleForceApproval, "staleForceApproval"],
  [REFUSAL.p0, "p0"],
  [REFUSAL.checksNotGreen, "checksNotGreen"],
  [REFUSAL.notMergeable, "notMergeable"],
  [SHIP_REFUSAL.mergeableUnknown, "mergeableUnknown"],
  [SHIP_REFUSAL.headMoved, "headMoved"],
]);

/**
 * A refusal code for a gate or GitHub refusal; `null` for any other failure (upstream, rate
 * limit, ...), which is reported as an error. Only reasons this codebase wrote are recognised:
 * a `conflict` with any other reason came from GitHub and is `githubRejected` (S4).
 */
function refusalCode(error: DomainError): RefusalCode | null {
  if (error.kind !== "conflict" && error.kind !== "forbidden") return null;
  const known = REFUSAL_CODES.get(error.reason);
  if (known) return known;
  return error.kind === "conflict" ? "githubRejected" : null;
}

function gateViews(gates: readonly MergeGate[], unknown: readonly MergeGateId[] = []): GateView[] {
  return gates.map((g) => ({
    id: g.id,
    status: unknown.includes(g.id) && g.status === "fail" ? "unknown" : g.status,
  }));
}

/** Errors are data with the fixed public message and a request id that matches a log line (S4). */
async function run<T>(
  deps: MergeDeps,
  name: string,
  work: (requestId: () => string) => Promise<Result<T>>,
): Promise<FnResult<T>> {
  let id: string | undefined;
  const requestId = () => (id ??= deps.ids.uuid());
  try {
    const result = await work(requestId);
    if (result.ok) return result;
    const error: DomainError = result.error;
    if (error.kind !== "not_found") {
      deps.logger.warn("merge server function failed", { fn: name, requestId: requestId(), error });
    }
    return { ok: false, error: toHttp(error, requestId()).body };
  } catch (error) {
    deps.logger.error("merge server function threw", {
      fn: name,
      requestId: requestId(),
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: unexpectedToHttp(error, requestId()).body };
  }
}

// ---- Queue ----

async function prEvents(events: ReviewEventRepo, prUrls: readonly string[]) {
  const lists = await mapLimit(prUrls, CONCURRENCY, (prUrl) =>
    events.list({ prUrl, types: ["merged", "force_approved"], limit: PR_EVENT_LIMIT }),
  );
  return new Map(prUrls.map((u, i) => [u, lists[i]!]));
}

/** Newest completed record per PR URL, in listed repos, newest first; at most `QUEUE_MAX`. */
async function latestReviewedPrs(
  records: ReviewRecordRepo,
  repos: readonly string[],
): Promise<Result<ReviewRecord[]>> {
  const keys = new Set(repos.map((r) => r.toLowerCase()));
  const seen = new Set<string>();
  const kept: ReviewRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SCAN_PAGES && kept.length < QUEUE_MAX; page++) {
    const res = await records.list({
      status: "completed",
      limit: RECORD_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!res.ok) return res;
    for (const r of res.value.items) {
      if (seen.has(r.prUrl)) continue;
      seen.add(r.prUrl);
      if (keys.has(`${r.owner}/${r.repo}`.toLowerCase())) kept.push(r);
      if (kept.length >= QUEUE_MAX) break;
    }
    cursor = res.value.nextCursor ?? undefined;
    if (cursor === undefined) break;
  }
  return ok(kept);
}

async function mergeQueue(deps: MergeDeps): Promise<Result<MergeQueueView>> {
  const records = deps.reviewRecords;
  const availability = await getGithubAvailability(deps);
  if (availability.state !== "ready") return ok({ github: availability.state, items: [] });
  const repos = await allowlist(deps);
  if (repos.length === 0) return ok({ github: "no_repos", items: [] });

  const latest = await latestReviewedPrs(records, repos);
  if (!latest.ok) return latest;
  const byPr = await prEvents(
    deps.reviewEvents,
    latest.value.map((r) => r.prUrl),
  );
  const unmerged = latest.value.filter(
    (r) => !(byPr.get(r.prUrl) ?? []).some((e) => e.type === "merged"),
  );
  if (unmerged.length === 0) return ok({ github: "ready", items: [] });

  const gh = await github(deps);
  if (!gh.ok) return gh;
  const live = await mapLimit(unmerged, CONCURRENCY, async (r) => {
    const ref: PrRef = { owner: r.owner, repo: r.repo, number: r.number, url: r.prUrl };
    // A plain read: the queue never waits for GitHub's mergeable computation.
    return gh.value.getPullRequest(ref);
  });

  const items: MergeQueueItem[] = [];
  unmerged.forEach((r, i) => {
    const meta = live[i]!;
    if (meta.ok && (meta.value.state !== "open" || meta.value.merged)) return;
    const forced = (byPr.get(r.prUrl) ?? []).some(
      (e: ReviewEventRecord) =>
        e.type === "force_approved" &&
        !!r.headSha &&
        e.sha?.toLowerCase() === r.headSha.toLowerCase(),
    );
    items.push({
      prUrl: r.prUrl,
      repo: `${r.owner}/${r.repo}`,
      number: r.number,
      reviewId: r.id,
      reviewedSha: r.headSha ?? null,
      shortSha: shortSha(r.headSha),
      verdict: r.verdict ?? null,
      forceApproved: forced,
      reviewedAt: r.finishedAt.toISOString(),
      source: r.source,
      title: meta.ok ? meta.value.title : null,
      author: meta.ok ? meta.value.author : null,
    });
  });
  return ok({ github: "ready", items });
}

// ---- Gates ----

/** A PR URL in the repo list, else `not_found` (repos outside the list are not enumerable). */
async function listedPr(deps: MergeDeps, prUrl: string): Promise<Result<PrRef>> {
  const ref = parsePrUrl(prUrl);
  if (!ref.ok) return err({ kind: "validation", field: "prUrl", message: "invalid PR URL" });
  const repos = await allowlist(deps);
  if (!isRepoAllowed({ owner: ref.value.owner, repo: ref.value.repo }, repos)) {
    return err({ kind: "not_found", entity: "pull_request" });
  }
  return ref;
}

async function mergeGatesView(
  deps: MergeDeps,
  actor: Actor,
  input: MergeGatesInput,
): Promise<Result<MergeGatesView>> {
  const ref = await listedPr(deps, input.prUrl);
  if (!ref.ok) return ref;
  const gh = await github(deps);
  if (!gh.ok) return gh;
  const ship = deps.shipDeps(gh.value);
  const list = await mergeChecklist(ship, { actor, prUrl: ref.value.url });
  if (!list.ok) return list;
  const c = list.value;
  let blockedReason: RefusalCode | null = null;
  if (c.blocked) {
    blockedReason =
      refusalCode(c.blocked) ??
      (c.unknown.includes("checks_green") ? "checksUnavailable" : "unavailable");
  }
  return ok({
    prUrl: c.prUrl,
    headSha: c.headSha,
    shortSha: c.headSha.slice(0, 7),
    state: c.state,
    gates: gateViews(c.gates, c.unknown),
    canMerge: c.canMerge,
    blockedReason,
    mergeableState: c.mergeableState,
    checks: c.checks
      ? { state: c.checks.state, failing: [...c.checks.failing], pending: [...c.checks.pending] }
      : null,
    p0Waived: c.p0Waived,
  });
}

// ---- Merge ----

const FORBIDDEN_NON_USER: DomainError = {
  kind: "forbidden",
  reason: "Only a signed-in user may merge.",
};

async function merge(
  deps: MergeDeps,
  actor: Actor,
  input: MergeInput,
  requestId: () => string,
): Promise<Result<MergeOutcomeView>> {
  // Machine actors never merge (FR-SHIP-05 1a); refused before any GitHub call or limiter hit.
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  const limit = await deps.rateLimiter.hit(`merge:${actor.userId}`, MERGE_RATE_LIMIT);
  if (!limit.allowed) return err({ kind: "rate_limited", retryAfterMs: limit.retryAfterMs });

  const ref = parsePrUrl(input.prUrl);
  if (!ref.ok) return err({ kind: "validation", field: "prUrl", message: "invalid PR URL" });
  const repos = await allowlist(deps);
  if (!isRepoAllowed({ owner: ref.value.owner, repo: ref.value.repo }, repos)) {
    return ok({
      status: "refused",
      reason: "repoNotAllowed",
      headMoved: false,
      gates: [],
      requestId: requestId(),
    });
  }
  const gh = await github(deps);
  if (!gh.ok) return gh;
  const ship = deps.shipDeps(gh.value);
  const out = await mergePr(ship, {
    actor,
    prUrl: ref.value.url,
    source: "web",
    expectedSha: input.expectedSha,
  });
  if (out.ok) {
    return ok(
      out.value.status === "merged"
        ? {
            status: "merged",
            sha: out.value.sha,
            mergeSha: out.value.mergeSha,
            p0Waived: out.value.p0Waived,
          }
        : { status: "already_merged" },
    );
  }
  return refusal(deps, out.error, requestId);
}

function refusal(
  deps: MergeDeps,
  failure: MergeFailure,
  requestId: () => string,
): Result<MergeOutcomeView> {
  const code = refusalCode(failure.error);
  if (code === null) return err(failure.error);
  // The reason may hold GitHub's text: it is logged here, never returned.
  deps.logger.warn("merge refused", { requestId: requestId(), code, error: failure.error });
  return ok({
    status: "refused",
    reason: code,
    headMoved: code === "headMoved",
    gates: gateViews(failure.gates, failure.unknown),
    requestId: requestId(),
  });
}

// ---- History ----

const asText = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

function toHistoryItem(e: ReviewEventRecord, actor: Actor): MergeHistoryItem {
  const ref = e.prUrl ? parsePrUrl(e.prUrl) : null;
  return {
    id: e.id,
    prUrl: e.prUrl ?? "",
    repo: ref?.ok ? `${ref.value.owner}/${ref.value.repo}` : null,
    number: ref?.ok ? ref.value.number : null,
    sha: e.sha ?? null,
    mergeSha: asText(e.detail?.mergeSha),
    actor: {
      kind: e.actor.kind,
      id: e.actor.id,
      self: actor.kind === "user" && e.actor.kind === "user" && e.actor.id === actor.userId,
    },
    source: e.source ?? null,
    at: e.at.toISOString(),
    reviewId: e.reviewId ?? null,
  };
}

/**
 * Every recorded merge, newest first. Not filtered by the repo list: merges of a removed repo
 * stay visible (FR-GITHUB-07), and the history needs no GitHub token.
 */
async function mergeHistory(
  deps: MergeDeps,
  actor: Actor,
  input: MergeHistoryInput,
): Promise<Result<MergeHistoryView>> {
  const limit = input.limit ?? HISTORY_DEFAULT;
  const events = await deps.reviewEvents.list({ types: ["merged"], limit: limit + 1 });
  return ok({
    items: events.slice(0, limit).map((e) => toHistoryItem(e, actor)),
    hasMore: events.length > limit,
  });
}

// ---- Entry points ----

export const loadMergeQueue = (deps: MergeDeps, _actor: Actor) =>
  run<MergeQueueView>(deps, "fetchMergeQueue", () => mergeQueue(deps));

export const loadMergeGates = (deps: MergeDeps, actor: Actor, input: MergeGatesInput) =>
  run<MergeGatesView>(deps, "fetchMergeGates", () => mergeGatesView(deps, actor, input));

export const runMerge = (deps: MergeDeps, actor: Actor, input: MergeInput) =>
  run<MergeOutcomeView>(deps, "mergePr", (requestId) => merge(deps, actor, input, requestId));

export const loadMergeHistory = (deps: MergeDeps, actor: Actor, input: MergeHistoryInput) =>
  run<MergeHistoryView>(deps, "fetchMergeHistory", () => mergeHistory(deps, actor, input));
