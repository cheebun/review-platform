import { getGithubAvailability } from "../application/settings/view";
import { selectLlmProvider } from "../domain/settings/llm-settings";
import { slackAvailability, type SecretReadState } from "../domain/settings/slack-settings";
import { ok, type DomainError, type Result } from "../domain/shared/result";
import type { ReviewEventRecord } from "../ports/review-event-repo";
import type { ReviewRecord, ReviewRecordQuery } from "../ports/review-record-repo";
import type { Ports } from "../server/container";
import { toHttp, unexpectedToHttp } from "../server/errors";
import type { FnResult } from "./fn-result";
import type { GithubState } from "./merge.logic";

/*
 * Server-only logic behind src/functions/workbench.ts: the overview `/` (docs/product.md §4.2).
 * Every function here is a read. None calls GitHub, Slack or an LLM: the cards are built
 * from stored records and settings only, so the page stays cheap and loads even when an upstream
 * service is down.
 */

/** What this module reads. Field names match the container's `Ports`. */
export type WorkbenchDeps = Pick<
  Ports,
  | "clock"
  | "ids"
  | "logger"
  | "githubRepos"
  | "reviewRecords"
  | "reviewEvents"
  | "githubCredentials"
  | "tokenCipher"
  | "settingsStore"
>;

export const REVIEW_WINDOW_DAYS = 7;
export const LATEST_REVIEWS = 5;
/** The review counts read at most this many store pages; beyond that they are `truncated`. */
const REVIEW_SCAN_PAGES = 10;
const RECORD_PAGE = 100;
/** The same cap as the /merge queue (`QUEUE_MAX` in merge.logic.ts). */
const MERGE_QUEUE_MAX = 50;
const MERGE_SCAN_PAGES = 5;
const EVENT_CONCURRENCY = 6;
const PR_EVENT_LIMIT = 50;

// ---- Views (JSON-safe: dates are ISO strings) ----

/** Inclusive UTC+8 calendar days, `YYYY-MM-DD`, as the /review `from`/`to` filters take them. */
export type ReviewWindow = { from: string; to: string; days: number };

export type LatestReview = {
  id: string;
  /** `owner/repo`. */
  repo: string;
  number: number;
  status: "completed" | "failed";
  verdict: "pass" | "changes_requested" | null;
  finishedAt: string;
};

export type ReviewSummaryView = {
  window: ReviewWindow;
  counts: { pass: number; changes_requested: number; failed: number };
  /** The window held more records than the scan reads; the counts are lower bounds. */
  truncated: boolean;
  latest: LatestReview[];
};

export type MergeSummaryView = {
  github: GithubState;
  /** Reviewed PRs with no recorded merge, newest review per PR: what /merge lists. */
  awaiting: number;
  /** Of those, 🟢 or force approved at the reviewed head. Live gates are checked on /merge. */
  passing: number;
  /** There may be more than `awaiting` (the /merge queue size or the scan was reached). */
  capped: boolean;
};

export type SetupState = "configured" | "not_configured" | "needs_reset";

/** Configuration state per /settings section. Never contains a value, a last-4 or a login. */
export type SetupStatusView = {
  github: SetupState;
  slack: SetupState;
  llm: SetupState;
};

// ---- Helpers ----

const UTC8_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;

const utc8Day = (ms: number) => new Date(ms + UTC8_MS).toISOString().slice(0, 10);

/** The last `REVIEW_WINDOW_DAYS` UTC+8 calendar days, today included, and the window's start. */
export function reviewWindow(now: Date): ReviewWindow & { start: Date } {
  const to = utc8Day(now.getTime());
  const todayStart = Date.parse(`${to}T00:00:00.000+08:00`);
  const start = new Date(todayStart - (REVIEW_WINDOW_DAYS - 1) * DAY_MS);
  return { from: utc8Day(start.getTime()), to, days: REVIEW_WINDOW_DAYS, start };
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

/** The repo list as lower-case keys: records of other repos are not enumerable (FR-REVIEW-07). */
async function listedRepos(deps: WorkbenchDeps): Promise<Set<string>> {
  return new Set((await deps.githubRepos.listRepos()).map((r) => r.canonical.toLowerCase()));
}

const repoKey = (r: ReviewRecord) => `${r.owner}/${r.repo}`.toLowerCase();

/**
 * Reads store pages newest first, calling `visit` per record until it returns false.
 * `exhausted`: every matching record was visited.
 */
async function scanRecords(
  deps: WorkbenchDeps,
  query: ReviewRecordQuery,
  maxPages: number,
  visit: (r: ReviewRecord) => boolean,
): Promise<Result<{ exhausted: boolean }>> {
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await deps.reviewRecords.list({
      ...query,
      limit: RECORD_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!res.ok) return res;
    cursor = res.value.nextCursor ?? undefined;
    for (const [i, r] of res.value.items.entries()) {
      if (!visit(r)) {
        const last = i === res.value.items.length - 1;
        return ok({ exhausted: last && cursor === undefined });
      }
    }
    if (cursor === undefined) return ok({ exhausted: true });
  }
  return ok({ exhausted: false });
}

/** Errors are data with the fixed public message and a request id that matches a log line (S4). */
async function run<T>(
  deps: WorkbenchDeps,
  name: string,
  work: () => Promise<Result<T>>,
): Promise<FnResult<T>> {
  try {
    const result = await work();
    if (result.ok) return result;
    const requestId = deps.ids.uuid();
    const error: DomainError = result.error;
    deps.logger.warn("workbench server function failed", { fn: name, requestId, error });
    return { ok: false, error: toHttp(error, requestId).body };
  } catch (error) {
    const requestId = deps.ids.uuid();
    deps.logger.error("workbench server function threw", {
      fn: name,
      requestId,
      // The name only: a driver or decrypt message may carry a host or a value.
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, error: unexpectedToHttp(error, requestId).body };
  }
}

// ---- Review summary ----

const toLatest = (r: ReviewRecord): LatestReview => ({
  id: r.id,
  repo: `${r.owner}/${r.repo}`,
  number: r.number,
  status: r.status,
  verdict: r.status === "completed" ? (r.verdict ?? null) : null,
  finishedAt: r.finishedAt.toISOString(),
});

async function reviewSummary(deps: WorkbenchDeps): Promise<Result<ReviewSummaryView>> {
  const { start, ...window } = reviewWindow(deps.clock.now());
  const keys = await listedRepos(deps);
  const counts = { pass: 0, changes_requested: 0, failed: 0 };
  const latest: LatestReview[] = [];
  if (keys.size === 0) return ok({ window, counts, truncated: false, latest });

  const counted = await scanRecords(deps, { from: start }, REVIEW_SCAN_PAGES, (r) => {
    if (!keys.has(repoKey(r))) return true;
    if (r.status === "failed") counts.failed += 1;
    else if (r.verdict === "pass") counts.pass += 1;
    else if (r.verdict === "changes_requested") counts.changes_requested += 1;
    if (latest.length < LATEST_REVIEWS) latest.push(toLatest(r));
    return true;
  });
  if (!counted.ok) return counted;

  if (latest.length < LATEST_REVIEWS) {
    // Too few in the window: the newest older reviews fill the list.
    const older = await scanRecords(deps, { to: new Date(start.getTime() - 1) }, 1, (r) => {
      if (keys.has(repoKey(r))) latest.push(toLatest(r));
      return latest.length < LATEST_REVIEWS;
    });
    if (!older.ok) return older;
  }
  return ok({ window, counts, truncated: !counted.value.exhausted, latest });
}

export const loadReviewSummary = (deps: WorkbenchDeps) =>
  run(deps, "fetchReviewSummary", () => reviewSummary(deps));

// ---- Merge summary ----

const forcedAtHead = (r: ReviewRecord, events: readonly ReviewEventRecord[]) => {
  const head = r.headSha?.toLowerCase();
  return (
    head !== undefined &&
    events.some((e) => e.type === "force_approved" && e.sha?.toLowerCase() === head)
  );
};

/**
 * The /merge queue's count without its live GitHub read: newest completed record per PR in
 * listed repos, minus PRs with a recorded merge. A PR closed or merged outside agent-ops still
 * counts here until /merge (which reads GitHub) drops it.
 */
async function mergeSummary(deps: WorkbenchDeps): Promise<Result<MergeSummaryView>> {
  const empty = { awaiting: 0, passing: 0, capped: false };
  const availability = await getGithubAvailability(deps);
  if (availability.state !== "ready") return ok({ github: availability.state, ...empty });
  const keys = await listedRepos(deps);
  if (keys.size === 0) return ok({ github: "no_repos", ...empty });

  const seen = new Set<string>();
  const latest: ReviewRecord[] = [];
  const scan = await scanRecords(deps, { status: "completed" }, MERGE_SCAN_PAGES, (r) => {
    if (seen.has(r.prUrl)) return true;
    seen.add(r.prUrl);
    if (keys.has(repoKey(r))) latest.push(r);
    return latest.length < MERGE_QUEUE_MAX;
  });
  if (!scan.ok) return scan;

  const events = await mapLimit(latest, EVENT_CONCURRENCY, (r) =>
    deps.reviewEvents.list({
      prUrl: r.prUrl,
      types: ["merged", "force_approved"],
      limit: PR_EVENT_LIMIT,
    }),
  );
  const unmerged = latest
    .map((r, i) => ({ r, list: events[i]! }))
    .filter(({ list }) => !list.some((e) => e.type === "merged"));
  return ok({
    github: "ready",
    awaiting: unmerged.length,
    passing: unmerged.filter(({ r, list }) => r.verdict === "pass" || forcedAtHead(r, list)).length,
    capped: !scan.value.exhausted,
  });
}

export const loadMergeSummary = (deps: WorkbenchDeps) =>
  run(deps, "fetchMergeSummary", () => mergeSummary(deps));

// ---- Setup status ----

const toSetup = (state: SecretReadState): SetupState => (state === "ready" ? "configured" : state);

/**
 * The availability rules of each /settings section (FR-GITHUB-05, FR-SLACKCFG-02,
 * FR-SETTINGS-01, FR-LLMCFG-01). Secret reads decrypt on the server; only the state leaves.
 */
async function setupStatus(deps: WorkbenchDeps): Promise<Result<SetupStatusView>> {
  const store = deps.settingsStore;
  const [github, slackUser, slackSigning, apiKey, authToken] = await Promise.all([
    getGithubAvailability(deps),
    store.getSecret("slack_user_token"),
    store.getSecret("slack_signing_secret"),
    store.getSecret("anthropic_api_key"),
    store.getSecret("anthropic_auth_token"),
  ]);
  const llm = selectLlmProvider({
    anthropic_api_key: apiKey.state,
    anthropic_auth_token: authToken.state,
  });
  return ok({
    github: toSetup(github.state),
    slack: toSetup(
      slackAvailability({
        slack_user_token: slackUser.state,
        slack_signing_secret: slackSigning.state,
      }),
    ),
    llm: llm.provider ? "configured" : llm.reason,
  });
}

export const loadSetupStatus = (deps: WorkbenchDeps) =>
  run(deps, "fetchSetupStatus", () => setupStatus(deps));
