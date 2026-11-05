import type { ReviewOutcomeFilter } from "../../../functions/review.logic";

/** The /review filters, kept in the URL so a filtered history can be shared and reloaded. */
export type ReviewSearch = {
  repo?: string;
  outcome?: ReviewOutcomeFilter;
  source?: "slack" | "web";
  /** `YYYY-MM-DD`, a UTC+8 calendar day, inclusive. */
  from?: string;
  to?: string;
};

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES: readonly string[] = ["pass", "changes_requested", "failed"];
const SOURCES: readonly string[] = ["slack", "web"];

const str = (v: unknown, ok: (s: string) => boolean) =>
  typeof v === "string" && ok(v) ? v : undefined;

/** Lenient: a malformed value is dropped, so a hand-edited URL still opens the page. */
export function validateReviewSearch(search: Record<string, unknown>): ReviewSearch {
  const out: ReviewSearch = {};
  const repo = str(search.repo, (s) => REPO_RE.test(s));
  if (repo) out.repo = repo;
  const outcome = str(search.outcome, (s) => OUTCOMES.includes(s));
  if (outcome) out.outcome = outcome as ReviewOutcomeFilter;
  const source = str(search.source, (s) => SOURCES.includes(s));
  if (source) out.source = source as "slack" | "web";
  const from = str(search.from, (s) => DAY_RE.test(s));
  if (from) out.from = from;
  const to = str(search.to, (s) => DAY_RE.test(s));
  if (to) out.to = to;
  return out;
}

export const hasFilters = (s: ReviewSearch) => Object.values(s).some((v) => v !== undefined);
