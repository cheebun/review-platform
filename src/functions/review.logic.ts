import { z } from "zod";
import type { Actor } from "../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../domain/shared/result";
import type {
  ReviewEventRecord,
  ReviewEventRepo,
  ReviewEventType,
  ReviewStepEventType,
} from "../ports/review-event-repo";
import type {
  RecordFinding,
  RequesterKind,
  ReviewRecord,
  ReviewRecordQuery,
  ReviewRecordSource,
  ReviewRecordStatus,
  ReviewVerdict,
} from "../ports/review-record-repo";
import type { Ports } from "../server/container";
import { toHttp, unexpectedToHttp } from "../server/errors";
import type { FnResult } from "./fn-result";

/*
 * Server-only logic behind src/functions/review.ts: the review history (`/review`, FR-REVIEW-06)
 * and the read-only detail (`/review/$reviewId`, FR-REVIEW-07). Nothing here writes.
 */

/** What this module reads. Field names match the container's `Ports`. */
export type ReviewDeps = Pick<
  Ports,
  "ids" | "logger" | "githubRepos" | "reviewEvents" | "reviewRecords"
>;

// ---- Input validation (shape only; date and cursor semantics become `validation` results) ----

export const REVIEW_OUTCOMES = ["pass", "changes_requested", "failed"] as const;
export type ReviewOutcomeFilter = (typeof REVIEW_OUTCOMES)[number];

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const listInputSchema = z.strictObject({
  repo: z.string().regex(REPO_RE).optional(),
  outcome: z.enum(REVIEW_OUTCOMES).optional(),
  source: z.enum(["slack", "web"]).optional(),
  from: z.string().regex(DAY_RE).optional(),
  to: z.string().regex(DAY_RE).optional(),
  cursor: z.string().min(1).max(600).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type ReviewListInput = z.infer<typeof listInputSchema>;

/** Validator for `fetchReviewList`. Throws on a malformed shape. */
export function parseReviewListInput(input: unknown): ReviewListInput {
  const parsed = listInputSchema.safeParse(input === undefined ? {} : input);
  if (!parsed.success) throw new Error("Invalid review list query.");
  return parsed.data;
}

const MAX_ID_LENGTH = 200;
/** Record ids are uuids today; anything outside this alphabet cannot be a stored id. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/** Validator for `fetchReviewDetail`: `{id}`. The format check is a `not_found`, not a throw. */
export function parseReviewIdInput(input: unknown): { id: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid input.");
  }
  const id = (input as Record<string, unknown>).id;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new Error("Invalid id.");
  }
  return { id };
}

// ---- Views (JSON-safe: dates are ISO strings) ----

/** The Slack markers (FR-REVIEW-06): 🟢 pass, 🔴 changes requested, 🟡 force approved. */
export type VerdictMarker = ReviewVerdict | "force_approved" | null;

export type ApprovalView = {
  kind: "approved" | "force_approved" | "skipped" | "failed";
  at: string;
  sha?: string;
  reason?: string;
  source?: "web" | "slack" | "system";
};

export type RequesterView = { kind: RequesterKind; id: string; self: boolean };

export type ReviewListItem = {
  id: string;
  prUrl: string;
  /** `owner/repo`. */
  repo: string;
  number: number;
  headSha: string | null;
  shortSha: string | null;
  source: ReviewRecordSource;
  requester: RequesterView;
  finishedAt: string;
  status: ReviewRecordStatus;
  verdict: ReviewVerdict | null;
  marker: VerdictMarker;
  merged: boolean;
  approval: ApprovalView | null;
  findingCounts: { severity: string; count: number }[];
};

export type ReviewListView = {
  items: ReviewListItem[];
  nextCursor: string | null;
  /** The settings repo list, for the repo filter. */
  repos: string[];
};

export type FindingView = {
  severity: string;
  title: string;
  body: string;
  path?: string;
  line?: number;
  /** A GitHub blob link at the reviewed SHA, only for a github.com PR. */
  href?: string;
};

export type TimelineItem = {
  id: string;
  type: ReviewStepEventType;
  actor: ReviewEventRecord["actor"];
  at: string;
  sha?: string;
  reason?: string;
  source?: "web" | "slack" | "system";
};

export type ReviewDetailView = {
  review: ReviewListItem & {
    baseSha: string | null;
    provider: string | null;
    model: string | null;
    startedAt: string;
    summary: string | null;
    errorCategory: string | null;
  };
  githubUrl: string | null;
  findingGroups: { severity: string; findings: FindingView[] }[];
  timeline: TimelineItem[];
  /** A later review of the same PR, so the page can say this one is stale. */
  newerReview: { id: string; shortSha: string | null } | null;
};

// ---- Derivations ----

export const SEVERITY_ORDER = ["P0", "P1", "P2", "Nit"] as const;

const severityRank = (s: string) => {
  const i = (SEVERITY_ORDER as readonly string[]).indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

const REVIEW_STEP_TYPES: readonly ReviewStepEventType[] = [
  "review_started",
  "review_finished",
  "review_failed",
  "comment_posted",
  "changes_requested",
  "approved",
  "approve_skipped",
  "approve_failed",
  "force_approved",
  "merged",
  "merge_failed",
];
const isStep = (t: ReviewEventType): t is ReviewStepEventType =>
  (REVIEW_STEP_TYPES as readonly string[]).includes(t);

const APPROVAL_KIND = {
  approved: "approved",
  force_approved: "force_approved",
  approve_skipped: "skipped",
  approve_failed: "failed",
} as const satisfies Partial<Record<ReviewStepEventType, ApprovalView["kind"]>>;
const APPROVAL_TYPES = Object.keys(APPROVAL_KIND) as (keyof typeof APPROVAL_KIND)[];

/**
 * Does an approval-type event belong to this review run? By review id, else by job (the queue's
 * auto-approve step), else, for an event with neither, by the reviewed SHA.
 */
function belongsTo(e: ReviewEventRecord, r: ReviewRecord): boolean {
  if (e.reviewId !== undefined) return e.reviewId === r.id;
  if (e.jobId !== undefined) return e.jobId === r.jobId;
  return e.sha !== undefined && e.sha === r.headSha;
}

function approvalOf(events: readonly ReviewEventRecord[], r: ReviewRecord): ApprovalView | null {
  // Events arrive newest first, so the first match is the current approval state.
  for (const e of events) {
    if (!(e.type in APPROVAL_KIND) || !belongsTo(e, r)) continue;
    const view: ApprovalView = {
      kind: APPROVAL_KIND[e.type as keyof typeof APPROVAL_KIND],
      at: e.at.toISOString(),
    };
    if (e.sha !== undefined) view.sha = e.sha;
    if (e.reason !== undefined) view.reason = e.reason;
    if (e.source !== undefined) view.source = e.source;
    return view;
  }
  return null;
}

const shortSha = (sha: string | undefined) => (sha ? sha.slice(0, 7) : null);

function toListItem(
  r: ReviewRecord,
  events: readonly ReviewEventRecord[],
  actor: Actor,
): ReviewListItem {
  const approval = approvalOf(events, r);
  const verdict = r.status === "completed" ? (r.verdict ?? null) : null;
  const counts = new Map<string, number>();
  for (const f of r.findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  return {
    id: r.id,
    prUrl: r.prUrl,
    repo: `${r.owner}/${r.repo}`,
    number: r.number,
    headSha: r.headSha ?? null,
    shortSha: shortSha(r.headSha),
    source: r.source,
    requester: {
      kind: r.requester.kind,
      id: r.requester.id,
      self: r.requester.kind === "user" && actor.kind === "user" && r.requester.id === actor.userId,
    },
    finishedAt: r.finishedAt.toISOString(),
    status: r.status,
    verdict,
    marker:
      verdict === null ? null : approval?.kind === "force_approved" ? "force_approved" : verdict,
    merged: events.some((e) => e.type === "merged"),
    approval,
    findingCounts: [...counts]
      .toSorted(([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b))
      .map(([severity, count]) => ({ severity, count })),
  };
}

/** `https://github.com/<owner>/<repo>/pull/<n>` only; anything else gets no outbound link. */
function githubPrUrl(r: ReviewRecord): string | null {
  try {
    const u = new URL(r.prUrl);
    const expected = `/${r.owner}/${r.repo}/pull/${r.number}`;
    if (u.protocol !== "https:" || u.hostname !== "github.com") return null;
    if (u.pathname.toLowerCase() !== expected.toLowerCase()) return null;
    return `https://github.com${expected}`;
  } catch {
    return null;
  }
}

function toFinding(f: RecordFinding, blobBase: string | null): FindingView {
  const view: FindingView = {
    severity: f.severity,
    title: f.titleZh || f.title,
    body: f.bodyZh || f.body,
  };
  if (f.path) view.path = f.path;
  if (f.line !== undefined) view.line = f.line;
  if (blobBase && f.path) {
    const path = f.path.split("/").map(encodeURIComponent).join("/");
    view.href = `${blobBase}/${path}${f.line !== undefined && f.line > 0 ? `#L${f.line}` : ""}`;
  }
  return view;
}

function groupFindings(r: ReviewRecord, githubUrl: string | null) {
  const blobBase =
    githubUrl && r.headSha ? `https://github.com/${r.owner}/${r.repo}/blob/${r.headSha}` : null;
  const groups = new Map<string, FindingView[]>();
  for (const f of r.findings) {
    const list = groups.get(f.severity) ?? [];
    list.push(toFinding(f, blobBase));
    groups.set(f.severity, list);
  }
  return [...groups]
    .toSorted(([a], [b]) => severityRank(a) - severityRank(b) || a.localeCompare(b))
    .map(([severity, findings]) => ({ severity, findings }));
}

function toTimelineItem(e: ReviewEventRecord & { type: ReviewStepEventType }): TimelineItem {
  const item: TimelineItem = { id: e.id, type: e.type, actor: e.actor, at: e.at.toISOString() };
  if (e.sha !== undefined) item.sha = e.sha;
  if (e.reason !== undefined) item.reason = e.reason;
  if (e.source !== undefined) item.source = e.source;
  return item;
}

/** `YYYY-MM-DD` as a UTC+8 calendar day (the app's working timezone), or null if not a date. */
function dayBound(day: string, edge: "start" | "end"): Date | null {
  const time = edge === "start" ? "00:00:00.000" : "23:59:59.999";
  const d = new Date(`${day}T${time}+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject rolled-over dates such as 02-30 by reading the UTC+8 day back.
  const back = new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  return back === day ? d : null;
}

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

const EVENT_FETCH_CONCURRENCY = 6;
const ROW_EVENT_LIMIT = 100;
const TIMELINE_LIMIT = 200;
/** A verdict filter is applied after the store query; scan at most this many store pages. */
const MAX_SCAN_PAGES = 5;
const LIST_EVENT_TYPES: readonly ReviewEventType[] = [...APPROVAL_TYPES, "merged"];

async function eventsByPr(
  events: ReviewEventRepo,
  prUrls: readonly string[],
): Promise<Map<string, ReviewEventRecord[]>> {
  const unique = [...new Set(prUrls)];
  const lists = await mapLimit(unique, EVENT_FETCH_CONCURRENCY, (prUrl) =>
    events.list({ prUrl, types: LIST_EVENT_TYPES, limit: ROW_EVENT_LIMIT }),
  );
  return new Map(unique.map((u, i) => [u, lists[i]!]));
}

const invalid = (field: string): Result<never> =>
  err({ kind: "validation", field, message: `invalid ${field}` });
const notFound = (): Result<never> => err({ kind: "not_found", entity: "review" });

async function allowlist(deps: ReviewDeps) {
  const repos = (await deps.githubRepos.listRepos()).map((r) => r.canonical);
  return { repos, keys: new Set(repos.map((r) => r.toLowerCase())) };
}

// ---- Use cases ----

async function listReviews(
  deps: ReviewDeps,
  actor: Actor,
  input: ReviewListInput,
): Promise<Result<ReviewListView>> {
  const records = deps.reviewRecords;
  const query: ReviewRecordQuery = {};
  if (input.from !== undefined) {
    const d = dayBound(input.from, "start");
    if (!d) return invalid("from");
    query.from = d;
  }
  if (input.to !== undefined) {
    const d = dayBound(input.to, "end");
    if (!d) return invalid("to");
    query.to = d;
  }
  const { repos, keys } = await allowlist(deps);
  if (input.repo !== undefined && !keys.has(input.repo.toLowerCase())) {
    // Not enumerable: a repo outside the list looks exactly like one with no history.
    return ok({ items: [], nextCursor: null, repos });
  }
  if (input.repo !== undefined) query.repo = input.repo;
  if (input.source !== undefined) query.source = input.source;
  if (input.outcome !== undefined)
    query.status = input.outcome === "failed" ? "failed" : "completed";
  if (input.limit !== undefined) query.limit = input.limit;
  const limit = input.limit ?? 50;

  const wanted = (r: ReviewRecord) =>
    keys.has(`${r.owner}/${r.repo}`.toLowerCase()) &&
    (input.outcome === undefined || input.outcome === "failed" || r.verdict === input.outcome);

  const kept: ReviewRecord[] = [];
  let cursor = input.cursor;
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const res = await records.list({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    if (!res.ok) return res;
    kept.push(...res.value.items.filter(wanted));
    cursor = res.value.nextCursor ?? undefined;
    if (kept.length >= limit || cursor === undefined) break;
  }

  const byPr = await eventsByPr(
    deps.reviewEvents,
    kept.map((r) => r.prUrl),
  );
  return ok({
    items: kept.map((r) => toListItem(r, byPr.get(r.prUrl) ?? [], actor)),
    nextCursor: cursor ?? null,
    repos,
  });
}

async function reviewDetail(
  deps: ReviewDeps,
  actor: Actor,
  input: { id: string },
): Promise<Result<ReviewDetailView>> {
  const records = deps.reviewRecords;
  if (!ID_RE.test(input.id)) return notFound();
  const record = await records.get(input.id);
  if (!record) return notFound();
  const { keys } = await allowlist(deps);
  // 404, not 403: records of repos outside the list are not enumerable (FR-REVIEW-07 AC2).
  if (!keys.has(`${record.owner}/${record.repo}`.toLowerCase())) return notFound();

  const [events, latest] = await Promise.all([
    deps.reviewEvents.list({ prUrl: record.prUrl, limit: TIMELINE_LIMIT }),
    records.latestForPr(record.prUrl),
  ]);
  const steps = events.filter((e): e is ReviewEventRecord & { type: ReviewStepEventType } =>
    isStep(e.type),
  );
  const githubUrl = githubPrUrl(record);
  const newer =
    latest && latest.id !== record.id && latest.finishedAt.getTime() > record.finishedAt.getTime()
      ? { id: latest.id, shortSha: shortSha(latest.headSha) }
      : null;

  return ok({
    review: {
      ...toListItem(record, steps, actor),
      baseSha: record.baseSha ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      startedAt: record.startedAt.toISOString(),
      summary: record.summary ?? null,
      errorCategory: record.errorCategory ?? null,
    },
    githubUrl,
    findingGroups: groupFindings(record, githubUrl),
    timeline: steps.toReversed().map(toTimelineItem),
    newerReview: newer,
  });
}

/** Errors are data with the fixed public message and a request id that matches a log line (S4). */
async function run<T>(
  deps: ReviewDeps,
  name: string,
  work: () => Promise<Result<T>>,
): Promise<FnResult<T>> {
  try {
    const result = await work();
    if (result.ok) return result;
    const requestId = deps.ids.uuid();
    const error: DomainError = result.error;
    if (error.kind !== "not_found") {
      deps.logger.warn("review server function failed", { fn: name, requestId, error });
    }
    return { ok: false, error: toHttp(error, requestId).body };
  } catch (error) {
    const requestId = deps.ids.uuid();
    deps.logger.error("review server function threw", {
      fn: name,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: unexpectedToHttp(error, requestId).body };
  }
}

export const loadReviewList = (deps: ReviewDeps, actor: Actor, input: ReviewListInput) =>
  run<ReviewListView>(deps, "fetchReviewList", () => listReviews(deps, actor, input));

export const loadReviewDetail = (deps: ReviewDeps, actor: Actor, input: { id: string }) =>
  run<ReviewDetailView>(deps, "fetchReviewDetail", () => reviewDetail(deps, actor, input));
