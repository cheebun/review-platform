import { err, ok, type Result } from "../domain/shared/result";

export type ReviewRecordSource = "slack" | "web";
export type ReviewRecordStatus = "completed" | "failed";
/** 🟢 `pass`, 🔴 `changes_requested`. A failed run has no verdict. */
export type ReviewVerdict = "pass" | "changes_requested";
/** `user`: a signed-in user id. `slack`: a Slack user id. `machine`: a machine caller. */
export type RequesterKind = "user" | "slack" | "machine";

/** Structurally the domain `Finding`; kept here so the port does not depend on review internals. */
export type RecordFinding = {
  severity: string;
  title: string;
  body: string;
  titleZh?: string;
  bodyZh?: string;
  path?: string;
  line?: number;
};

export type NewReviewRecord = {
  id: string;
  jobId: string;
  /** The job's attempt count at the terminal transition (>= 1). A retry writes a new record. */
  run: number;
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  headSha?: string;
  baseSha?: string;
  source: ReviewRecordSource;
  requester: { kind: RequesterKind; id: string };
  provider?: string;
  model?: string;
  startedAt: Date;
  finishedAt: Date;
  status: ReviewRecordStatus;
  /** Required when `completed`, absent when `failed`. */
  verdict?: ReviewVerdict;
  /** Required when `failed`: a generic, non-leaking category such as `upstream_llm`. */
  errorCategory?: string;
  summary?: string;
  findings: readonly RecordFinding[];
};

export type ReviewRecord = Omit<NewReviewRecord, "findings"> & { findings: RecordFinding[] };

export type ReviewRecordQuery = {
  /** `owner/repo`, matched case-insensitively. */
  repo?: string;
  number?: number;
  prUrl?: string;
  status?: ReviewRecordStatus;
  source?: ReviewRecordSource;
  /** Inclusive bounds on `finishedAt`. */
  from?: Date;
  to?: Date;
  /** 1..100, default 50. */
  limit?: number;
  /** Opaque, from a previous page's `nextCursor`. */
  cursor?: string;
};

export type ReviewRecordPage = { items: ReviewRecord[]; nextCursor: string | null };

/**
 * Durable review records (`review_result`, FR-REVIEW-05). Insert-only: a record is never
 * updated. Ordering everywhere is newest `finishedAt` first, then `id` descending.
 */
export interface ReviewRecordRepo {
  /**
   * Idempotent on (jobId, prUrl, run): a repeat returns the stored record with `inserted: false`.
   * An `id` already used by a different run gives `conflict`; bad input gives `validation`.
   */
  insert(record: NewReviewRecord): Promise<Result<{ record: ReviewRecord; inserted: boolean }>>;
  get(id: string): Promise<ReviewRecord | null>;
  /** The newest record for a PR URL (approve and merge preconditions). */
  latestForPr(prUrl: string): Promise<ReviewRecord | null>;
  /** Filters combine with AND. Keyset pagination: stable while new records are appended. */
  list(query: ReviewRecordQuery): Promise<Result<ReviewRecordPage>>;
}

// ---- Boundary validation, shared by every implementation ----

export const REVIEW_RECORD_PAGE_DEFAULT = 50;
export const REVIEW_RECORD_PAGE_MAX = 100;

const MAX_TEXT = 200;
const MAX_URL = 500;
const MAX_SUMMARY = 20_000;
const MAX_FINDINGS = 500;
const SHA = /^[0-9a-f]{7,64}$/i;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const REPO_FILTER = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;

const invalid = (field: string, message: string): Result<never> =>
  err({ kind: "validation", field, message });

const isText = (v: unknown, max = MAX_TEXT): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());
const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

function isFinding(f: unknown): f is RecordFinding {
  if (typeof f !== "object" || f === null) return false;
  const x = f as Record<string, unknown>;
  const optText = (k: string) => x[k] === undefined || typeof x[k] === "string";
  return (
    isText(x.severity, 20) &&
    typeof x.title === "string" &&
    typeof x.body === "string" &&
    optText("titleZh") &&
    optText("bodyZh") &&
    optText("path") &&
    (x.line === undefined || (typeof x.line === "number" && Number.isSafeInteger(x.line)))
  );
}

export function validateNewReviewRecord(r: NewReviewRecord): Result<NewReviewRecord> {
  if (!isText(r.id)) return invalid("id", "id must be 1..200 characters");
  if (!isText(r.jobId)) return invalid("jobId", "jobId must be 1..200 characters");
  if (!isPositiveInt(r.run)) return invalid("run", "run must be a positive integer");
  if (!isText(r.prUrl, MAX_URL) || !r.prUrl.startsWith("https://"))
    return invalid("prUrl", "prUrl must be an https URL");
  if (typeof r.owner !== "string" || !NAME.test(r.owner)) return invalid("owner", "invalid owner");
  if (typeof r.repo !== "string" || !NAME.test(r.repo)) return invalid("repo", "invalid repo");
  if (!isPositiveInt(r.number)) return invalid("number", "number must be a positive integer");
  if (r.headSha !== undefined && !SHA.test(r.headSha)) return invalid("headSha", "invalid SHA");
  if (r.baseSha !== undefined && !SHA.test(r.baseSha)) return invalid("baseSha", "invalid SHA");
  if (r.source !== "slack" && r.source !== "web") return invalid("source", "invalid source");
  if (
    !r.requester ||
    !["user", "slack", "machine"].includes(r.requester.kind) ||
    !isText(r.requester.id)
  )
    return invalid("requester", "invalid requester");
  if (r.provider !== undefined && !isText(r.provider))
    return invalid("provider", "invalid provider");
  if (r.model !== undefined && !isText(r.model)) return invalid("model", "invalid model");
  if (!isDate(r.startedAt)) return invalid("startedAt", "invalid date");
  if (!isDate(r.finishedAt)) return invalid("finishedAt", "invalid date");
  if (r.finishedAt.getTime() < r.startedAt.getTime())
    return invalid("finishedAt", "finishedAt is before startedAt");
  if (r.status === "completed") {
    if (r.verdict !== "pass" && r.verdict !== "changes_requested")
      return invalid("verdict", "a completed review needs a verdict");
    if (r.errorCategory !== undefined)
      return invalid("errorCategory", "a completed review has no error category");
  } else if (r.status === "failed") {
    if (r.verdict !== undefined) return invalid("verdict", "a failed review has no verdict");
    if (typeof r.errorCategory !== "string" || !CATEGORY.test(r.errorCategory))
      return invalid("errorCategory", "a failed review needs an error category");
  } else {
    return invalid("status", "invalid status");
  }
  if (r.summary !== undefined && (typeof r.summary !== "string" || r.summary.length > MAX_SUMMARY))
    return invalid("summary", "summary too long");
  if (!Array.isArray(r.findings) || r.findings.length > MAX_FINDINGS)
    return invalid("findings", "findings must be an array of at most 500");
  if (!r.findings.every(isFinding)) return invalid("findings", "malformed finding");
  return ok(r);
}

export type ReviewRecordCursor = { finishedAtMs: number; id: string };

export function encodeReviewRecordCursor(c: ReviewRecordCursor): string {
  return Buffer.from(JSON.stringify([c.finishedAtMs, c.id]), "utf8").toString("base64url");
}

export function decodeReviewRecordCursor(raw: string): ReviewRecordCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 600) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      isText(parsed[1])
    ) {
      return { finishedAtMs: parsed[0] as number, id: parsed[1] as string };
    }
  } catch {
    // fall through
  }
  return null;
}

export type ValidReviewRecordQuery = {
  owner?: string;
  repo?: string;
  number?: number;
  prUrl?: string;
  status?: ReviewRecordStatus;
  source?: ReviewRecordSource;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: ReviewRecordCursor;
};

export function validateReviewRecordQuery(q: ReviewRecordQuery): Result<ValidReviewRecordQuery> {
  const out: ValidReviewRecordQuery = { limit: REVIEW_RECORD_PAGE_DEFAULT };
  if (q.repo !== undefined) {
    const m = typeof q.repo === "string" ? REPO_FILTER.exec(q.repo) : null;
    if (!m) return invalid("repo", "repo must be owner/repo");
    out.owner = m[1]!;
    out.repo = m[2]!;
  }
  if (q.number !== undefined) {
    if (!isPositiveInt(q.number)) return invalid("number", "number must be a positive integer");
    out.number = q.number;
  }
  if (q.prUrl !== undefined) {
    if (!isText(q.prUrl, MAX_URL)) return invalid("prUrl", "invalid prUrl");
    out.prUrl = q.prUrl;
  }
  if (q.status !== undefined) {
    if (q.status !== "completed" && q.status !== "failed")
      return invalid("status", "invalid status");
    out.status = q.status;
  }
  if (q.source !== undefined) {
    if (q.source !== "slack" && q.source !== "web") return invalid("source", "invalid source");
    out.source = q.source;
  }
  if (q.from !== undefined) {
    if (!isDate(q.from)) return invalid("from", "invalid date");
    out.from = q.from;
  }
  if (q.to !== undefined) {
    if (!isDate(q.to)) return invalid("to", "invalid date");
    out.to = q.to;
  }
  if (out.from && out.to && out.from.getTime() > out.to.getTime())
    return invalid("from", "from is after to");
  if (q.limit !== undefined) {
    if (!isPositiveInt(q.limit) || q.limit > REVIEW_RECORD_PAGE_MAX)
      return invalid("limit", "limit must be 1..100");
    out.limit = q.limit;
  }
  if (q.cursor !== undefined) {
    const c = decodeReviewRecordCursor(q.cursor);
    if (!c) return invalid("cursor", "invalid cursor");
    out.cursor = c;
  }
  return ok(out);
}
