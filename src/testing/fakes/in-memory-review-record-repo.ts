import { err, ok, type Result } from "../../domain/shared/result";
import {
  encodeReviewRecordCursor,
  validateNewReviewRecord,
  validateReviewRecordQuery,
  type NewReviewRecord,
  type ReviewRecord,
  type ReviewRecordPage,
  type ReviewRecordQuery,
  type ReviewRecordRepo,
} from "../../ports/review-record-repo";

/** Newest finishedAt first, then id descending (the PG ORDER BY, byte-wise on ids). */
const newestFirst = (a: ReviewRecord, b: ReviewRecord) =>
  b.finishedAt.getTime() - a.finishedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const toRecord = (r: NewReviewRecord): ReviewRecord => {
  const out = structuredClone({ ...r, findings: [...r.findings] }) as ReviewRecord;
  for (const k of Object.keys(out) as (keyof ReviewRecord)[])
    if (out[k] === undefined) delete out[k];
  return out;
};

export class InMemoryReviewRecordRepo implements ReviewRecordRepo {
  private readonly records: ReviewRecord[] = [];

  async insert(
    input: NewReviewRecord,
  ): Promise<Result<{ record: ReviewRecord; inserted: boolean }>> {
    const valid = validateNewReviewRecord(input);
    if (!valid.ok) return valid;
    const existing = this.records.find(
      (r) => r.jobId === input.jobId && r.prUrl === input.prUrl && r.run === input.run,
    );
    if (existing) return ok({ record: structuredClone(existing), inserted: false });
    if (this.records.some((r) => r.id === input.id))
      return err({ kind: "conflict", reason: "review record id already used" });
    const record = toRecord(input);
    this.records.push(record);
    return ok({ record: structuredClone(record), inserted: true });
  }

  async get(id: string): Promise<ReviewRecord | null> {
    const r = this.records.find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }

  async latestForPr(prUrl: string): Promise<ReviewRecord | null> {
    const [r] = this.records.filter((x) => x.prUrl === prUrl).toSorted(newestFirst);
    return r ? structuredClone(r) : null;
  }

  async list(query: ReviewRecordQuery): Promise<Result<ReviewRecordPage>> {
    const v = validateReviewRecordQuery(query);
    if (!v.ok) return v;
    const q = v.value;
    const lower = (s: string) => s.toLowerCase();
    const rows = this.records
      .filter(
        (r) =>
          (q.owner === undefined || lower(r.owner) === lower(q.owner)) &&
          (q.repo === undefined || lower(r.repo) === lower(q.repo)) &&
          (q.number === undefined || r.number === q.number) &&
          (q.prUrl === undefined || r.prUrl === q.prUrl) &&
          (q.status === undefined || r.status === q.status) &&
          (q.source === undefined || r.source === q.source) &&
          (q.from === undefined || r.finishedAt.getTime() >= q.from.getTime()) &&
          (q.to === undefined || r.finishedAt.getTime() <= q.to.getTime()) &&
          (q.cursor === undefined ||
            r.finishedAt.getTime() < q.cursor.finishedAtMs ||
            (r.finishedAt.getTime() === q.cursor.finishedAtMs && r.id < q.cursor.id)),
      )
      .toSorted(newestFirst);
    const items = rows.slice(0, q.limit).map((r) => structuredClone(r));
    const last = items.at(-1);
    const nextCursor =
      rows.length > q.limit && last
        ? encodeReviewRecordCursor({ finishedAtMs: last.finishedAt.getTime(), id: last.id })
        : null;
    return ok({ items, nextCursor });
  }
}
