import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { PrRef } from "../../domain/github/pr-ref";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import {
  ACCESSIBLE_REPOS_BUDGET_MS,
  ACCESSIBLE_REPOS_MAX_PAGES,
  ACCESSIBLE_REPOS_PAGE_SIZE,
  type AccessibleRepo,
  type AccessibleRepoList,
  type ListAccessibleReposOptions,
  MERGE_METHODS,
  MERGEABLE_MAX_READS,
  toMergeableState,
  type ChecksSummary,
  type FoundReview,
  type GetPullRequestOptions,
  type GitHubPort,
  type ListOpenOptions,
  type MergeMethod,
  type MergeOptions,
  type MergeResult,
  type OpenPullRequest,
  type PullRequestDiff,
  type PullRequestMeta,
  type RepoRef,
  type ReviewState,
  type SubmitReviewInput,
} from "../../ports/github";
import { checkRunSchema, commitStatusSchema, summarizeChecks } from "./checks";
import { assembleDiff, type ChangedFile, type DiffSource } from "./diff-recovery";
import { failure, GitHubSchemaError } from "./errors";
import { retryingFetch, type RetryOptions } from "./retrying-fetch";

export type OctokitGitHubOptions = {
  token: string;
  userAgent: string;
  baseUrl?: string;
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** Clock used only to turn `x-ratelimit-reset` into a delay. */
  now?: () => number;
  /**
   * Merge methods from config, in order of preference. The first one the repository allows is
   * used. Empty or absent means merging is refused with `validation` (no built-in default).
   */
  mergeMethods?: readonly MergeMethod[];
  /** Bounded retry on 5xx, timeouts and secondary rate limits. */
  retry?: RetryOptions;
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Delay before each re-read while GitHub computes `mergeable`; one entry per re-read, so at
   * most `MERGEABLE_MAX_READS - 1` are used. Default 300, 600, 1200 ms (2.1 s worst case).
   */
  mergeableRetryDelaysMs?: readonly number[];
  /** Whole-listing budget for `listAccessibleRepos`. Default `ACCESSIBLE_REPOS_BUDGET_MS`. */
  reposBudgetMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MERGEABLE_RETRY_DELAYS_MS = [300, 600, 1200] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRAPHQL_CHUNK = 40;
/** Path-safe commit reference: alphanumeric, at most a SHA-256 hex length. */
const SHA_PATTERN = /^[0-9A-Za-z]{1,64}$/;

const isMergeMethod = (value: unknown): value is MergeMethod =>
  typeof value === "string" && (MERGE_METHODS as readonly string[]).includes(value);

const authenticatedSchema = z.object({ login: z.string(), id: z.number().optional() });
const reviewSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string(), id: z.number().optional() }).nullable(),
  state: z.string(),
  commit_id: z.string().nullable().optional(),
});
const repoMergeSettingsSchema = z.object({
  allow_merge_commit: z.boolean().nullable().optional(),
  allow_squash_merge: z.boolean().nullable().optional(),
  allow_rebase_merge: z.boolean().nullable().optional(),
});
/** One `GET /user/repos` entry; only the fields the picker shows. */
const accessibleRepoSchema = z.object({
  full_name: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  private: z.boolean(),
  archived: z.boolean().nullish(),
  permissions: z.object({ push: z.boolean().nullish() }).nullish(),
});

const hasNextPage = (link: string | undefined) => /rel="next"/.test(link ?? "");

const mergeResponseSchema = z.union([
  z.object({ merged: z.literal(true), sha: z.string().min(1) }),
  z.object({ merged: z.literal(false) }),
]);

/** Validates untrusted GitHub data; a mismatch is a non-retryable upstream error. */
function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new GitHubSchemaError(what);
  return result.data;
}

const invalid = (field: string, message: string) =>
  err<DomainError>({ kind: "validation", field, message });

/** GitHubPort over Octokit. The token is resolved by the caller, never read from the environment. */
export class OctokitGitHub implements GitHubPort {
  private readonly octokit: Octokit;
  private readonly now: () => number;
  private readonly mergeMethods: readonly MergeMethod[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mergeableDelays: readonly number[];
  private readonly reposBudgetMs: number;

  constructor(options: OctokitGitHubOptions) {
    this.now = options.now ?? (() => Date.now());
    for (const method of options.mergeMethods ?? []) {
      if (!isMergeMethod(method))
        throw new Error(`unknown merge method in config: ${String(method)}`);
    }
    this.mergeMethods = [...new Set(options.mergeMethods ?? [])];
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.sleep = sleep;
    const delays = options.mergeableRetryDelaysMs ?? DEFAULT_MERGEABLE_RETRY_DELAYS_MS;
    if (delays.some((ms) => !Number.isFinite(ms) || ms < 0 || ms > 10_000)) {
      throw new Error("mergeableRetryDelaysMs entries must be 0..10000 ms");
    }
    this.mergeableDelays = delays.slice(0, MERGEABLE_MAX_READS - 1);
    const budget = options.reposBudgetMs ?? ACCESSIBLE_REPOS_BUDGET_MS;
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error("reposBudgetMs must be a positive number of milliseconds");
    }
    this.reposBudgetMs = budget;
    this.octokit = new Octokit({
      auth: options.token,
      userAgent: options.userAgent,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      request: {
        // Every attempt is bounded by a timeout; reads are retried on 5xx and timeouts, and any
        // request on a short secondary rate limit. Writes are never repeated after a 5xx.
        fetch: retryingFetch({
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          retry: options.retry,
          sleep,
        }),
      },
    });
  }

  private async guard<T>(
    entity: string,
    run: () => Promise<T>,
    merge = false,
  ): Promise<Result<T, DomainError>> {
    try {
      return ok(await run());
    } catch (error) {
      return failure(error, { entity, merge, now: this.now });
    }
  }

  listOpenPullRequests(repo: RepoRef, options: ListOpenOptions) {
    return this.guard("repository", async (): Promise<OpenPullRequest[]> => {
      const allow = new Set(options.authors.map((name) => name.toLowerCase()));
      const cutoff = options.now.getTime() - options.maxAgeDays * DAY_MS;
      const data = await this.octokit.paginate(this.octokit.pulls.list, {
        owner: repo.owner,
        repo: repo.repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 100,
      });
      const items = data
        .filter((pr) => {
          if (pr.draft) return false;
          if (!allow.has((pr.user?.login ?? "").toLowerCase())) return false;
          const updatedAt = Date.parse(pr.updated_at);
          return Number.isFinite(updatedAt) && updatedAt >= cutoff;
        })
        .map((pr): OpenPullRequest => ({
          number: pr.number,
          title: pr.title,
          author: pr.user?.login ?? "unknown",
          htmlUrl: pr.html_url,
          draft: false,
          updatedAt: pr.updated_at,
          base: pr.base.ref,
          head: pr.head.ref,
          approved: false,
        }));
      const approved = await this.approvedNumbers(
        repo,
        items.map((item) => item.number),
      );
      return items.map((item) => ({ ...item, approved: approved.has(item.number) }));
    });
  }

  /** Batch-fetches reviewDecision; returns the PR numbers that are APPROVED. */
  private async approvedNumbers(repo: RepoRef, numbers: number[]): Promise<Set<number>> {
    const approved = new Set<number>();
    for (let i = 0; i < numbers.length; i += GRAPHQL_CHUNK) {
      const fields = numbers
        .slice(i, i + GRAPHQL_CHUNK)
        .map(
          (n, index) =>
            `p${index}: pullRequest(number: ${Math.trunc(n)}) { number reviewDecision }`,
        )
        .join("\n");
      const result = await this.octokit.graphql<{
        repository: Record<string, { number: number; reviewDecision: string | null } | null> | null;
      }>(
        `query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            ${fields}
          }
        }`,
        { owner: repo.owner, repo: repo.repo },
      );
      for (const node of Object.values(result.repository ?? {})) {
        if (node?.reviewDecision === "APPROVED") approved.add(node.number);
      }
    }
    return approved;
  }

  private async fetchMeta(ref: PrRef): Promise<PullRequestMeta> {
    const { data: pr } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    return {
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      base: pr.base.ref,
      head: pr.head.ref,
      sha: pr.head.sha,
      baseSha: pr.base.sha,
      state: pr.state === "open" ? "open" : "closed",
      merged: pr.merged,
      draft: pr.draft ?? false,
      changedFiles: pr.changed_files,
      htmlUrl: pr.html_url,
      // Untrusted: anything but a real boolean is "still computing" (unknown), never mergeable.
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      mergeableState:
        typeof pr.mergeable === "boolean" ? toMergeableState(pr.mergeable_state) : "unknown",
    };
  }

  async getPullRequest(
    ref: PrRef,
    options: GetPullRequestOptions = {},
  ): Promise<Result<PullRequestMeta, DomainError>> {
    const first = await this.guard("pull_request", () => this.fetchMeta(ref));
    if (!first.ok || !options.awaitMergeable) return first;
    let meta = first.value;
    // GitHub starts computing `mergeable` on the first read and answers null until it is done.
    for (const delay of this.mergeableDelays) {
      if (!(meta.mergeable === null && meta.state === "open" && !meta.merged)) break;
      await this.sleep(delay);
      const next = await this.guard("pull_request", () => this.fetchMeta(ref));
      // A failed re-read keeps the earlier read; its null mergeable fails the gate closed.
      if (!next.ok) break;
      meta = next.value;
    }
    return ok(meta);
  }

  getAuthenticatedLogin() {
    return this.guard("user", async () => (await this.octokit.users.getAuthenticated()).data.login);
  }

  /**
   * `GET /user/repos`, page by page, until the last page, `ACCESSIBLE_REPOS_MAX_PAGES` pages or
   * the time budget, whichever comes first. A cut-short listing is `truncated`. Each repository
   * is validated on its own; a malformed entry is skipped, never shown.
   */
  listAccessibleRepos(options: ListAccessibleReposOptions = {}) {
    return this.guard("user", async (): Promise<AccessibleRepoList> => {
      const started = this.now();
      const deadline = AbortSignal.timeout(this.reposBudgetMs);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const repos: AccessibleRepo[] = [];
      let read = 0;
      try {
        // Paged by hand: Octokit's paginate iterator drops `request.signal`.
        for (let pageNo = 1; pageNo <= ACCESSIBLE_REPOS_MAX_PAGES; pageNo++) {
          const page = await this.octokit.request("GET /user/repos", {
            affiliation: "owner,collaborator,organization_member",
            per_page: ACCESSIBLE_REPOS_PAGE_SIZE,
            sort: "full_name",
            page: pageNo,
            request: { signal },
          });
          read++;
          for (const raw of parse(z.array(z.unknown()), page.data, "repositories")) {
            const item = accessibleRepoSchema.safeParse(raw);
            if (!item.success) continue;
            repos.push({
              fullName: item.data.full_name,
              private: item.data.private,
              archived: item.data.archived ?? false,
              canPush: item.data.permissions?.push === true,
            });
          }
          if (!hasNextPage(page.headers.link)) return { repos, truncated: false };
          const outOfTime = this.now() - started >= this.reposBudgetMs;
          if (pageNo === ACCESSIBLE_REPOS_MAX_PAGES || outOfTime) return { repos, truncated: true };
        }
      } catch (error) {
        // The budget ran out mid-listing: keep what was read. A caller abort is an error.
        if (read > 0 && deadline.aborted && !options.signal?.aborted) {
          return { repos, truncated: true };
        }
        throw error;
      }
      return { repos, truncated: false };
    });
  }

  getDiff(ref: PrRef): Promise<Result<PullRequestDiff, DomainError>> {
    const o = this.octokit;
    const source: DiffSource = {
      getMeta: () => this.fetchMeta(ref),
      listFiles: async () =>
        (
          await o.paginate(o.pulls.listFiles, {
            owner: ref.owner,
            repo: ref.repo,
            pull_number: ref.number,
            per_page: 100,
          })
        ).map((f): ChangedFile => ({
          filename: f.filename,
          previous_filename: f.previous_filename,
          status: f.status,
          sha: f.sha ?? null,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
      mergeBase: async (base, head) => {
        const { data } = await o.repos.compareCommits({
          owner: ref.owner,
          repo: ref.repo,
          base,
          head,
          per_page: 1,
        });
        const sha = data.merge_base_commit.sha;
        if (!sha) throw new Error("cannot determine the PR merge base");
        return sha;
      },
      fileShaAt: async (path, commit) => {
        const { data } = await o.repos.getContent({
          owner: ref.owner,
          repo: ref.repo,
          path,
          ref: commit,
        });
        if (Array.isArray(data) || data.type !== "file" || !data.sha) {
          throw new Error("cannot read the file at the merge base");
        }
        return data.sha;
      },
      readBlob: async (sha) => {
        const { data } = await o.git.getBlob({ owner: ref.owner, repo: ref.repo, file_sha: sha });
        return {
          sha: data.sha,
          encoding: data.encoding,
          size: data.size ?? -1,
          content: data.content,
        };
      },
    };
    return this.guard("pull_request", () => assembleDiff(source));
  }

  findCommentByMarker(ref: PrRef, marker: string) {
    return this.guard("pull_request", async () => {
      const pages = this.octokit.paginate.iterator(this.octokit.issues.listComments, {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
        per_page: 100,
      });
      for await (const page of pages) {
        const hit = page.data.find((comment) => comment.body?.includes(marker));
        if (hit) return { id: hit.id };
      }
      return null;
    });
  }

  createComment(ref: PrRef, body: string) {
    return this.guard("pull_request", async () => {
      const { data } = await this.octokit.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
        body,
      });
      return { id: data.id };
    });
  }

  findReviewByMarker(
    ref: PrRef,
    marker: string,
    filter: { commitId?: string; state?: ReviewState } = {},
  ) {
    return this.guard("pull_request", async (): Promise<FoundReview | null> => {
      const { data: actor } = await this.octokit.users.getAuthenticated();
      const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
        per_page: 100,
      });
      const mine = reviews
        .filter(
          (r) =>
            r.user?.login.toLowerCase() === actor.login.toLowerCase() &&
            (r.body ?? "").includes(marker) &&
            (filter.commitId === undefined || r.commit_id === filter.commitId) &&
            (filter.state === undefined || r.state === filter.state),
        )
        .toSorted((a, b) => b.id - a.id)[0];
      return mine
        ? { id: mine.id, commitId: mine.commit_id ?? null, state: mine.state as ReviewState }
        : null;
    });
  }

  submitReview(ref: PrRef, input: SubmitReviewInput) {
    return this.guard("pull_request", async () => {
      // GitHub requires a body for REQUEST_CHANGES / COMMENT; use an invisible placeholder.
      const body = input.body?.trim() || (input.event === "APPROVE" ? undefined : "<!-- -->");
      const { data } = await this.octokit.pulls.createReview({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
        event: input.event,
        ...(input.commitId ? { commit_id: input.commitId } : {}),
        ...(body != null ? { body } : {}),
      });
      return { id: data.id };
    });
  }

  getChecks(repo: RepoRef, sha: string): Promise<Result<ChecksSummary, DomainError>> {
    if (!SHA_PATTERN.test(sha)) return Promise.resolve(invalid("sha", "malformed commit SHA"));
    return this.guard("commit", async () => {
      const o = this.octokit;
      const [runs, statuses] = await Promise.all([
        o.paginate(o.checks.listForRef, {
          owner: repo.owner,
          repo: repo.repo,
          ref: sha,
          filter: "latest",
          per_page: 100,
        }),
        o.paginate(o.repos.listCommitStatusesForRef, {
          owner: repo.owner,
          repo: repo.repo,
          ref: sha,
          per_page: 100,
        }),
      ]);
      return summarizeChecks(
        parse(z.array(checkRunSchema), runs, "check runs"),
        parse(z.array(commitStatusSchema), statuses, "commit statuses"),
      );
    });
  }

  hasApproval(ref: PrRef, sha: string): Promise<Result<boolean, DomainError>> {
    if (!SHA_PATTERN.test(sha)) return Promise.resolve(invalid("sha", "malformed commit SHA"));
    return this.guard("pull_request", async () => {
      const o = this.octokit;
      const me = parse(authenticatedSchema, (await o.users.getAuthenticated()).data, "user");
      const reviews = parse(
        z.array(reviewSchema),
        await o.paginate(o.pulls.listReviews, {
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
          per_page: 100,
        }),
        "reviews",
      );
      const mine = (user: { login: string; id?: number } | null) =>
        user != null &&
        (me.id != null && user.id != null
          ? user.id === me.id
          : user.login.toLowerCase() === me.login.toLowerCase());
      // Only APPROVED and CHANGES_REQUESTED change the review decision on GitHub; dismissed,
      // pending and comment-only reviews are ignored.
      const latest = reviews
        .filter((r) => mine(r.user) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"))
        .reduce<(typeof reviews)[number] | null>((a, b) => (a && a.id > b.id ? a : b), null);
      return latest?.state === "APPROVED" && latest.commit_id === sha;
    });
  }

  /** Picks the merge method: the per-call one, else the first configured one the repo allows. */
  private async resolveMergeMethod(
    ref: PrRef,
    requested: MergeMethod | undefined,
  ): Promise<Result<MergeMethod, DomainError>> {
    if (requested !== undefined) return ok(requested);
    const preferences = this.mergeMethods;
    if (preferences.length === 0) return invalid("mergeMethod", "no merge method configured");
    if (preferences.length === 1) return ok(preferences[0]);
    const settings = await this.guard("repository", async () =>
      parse(
        repoMergeSettingsSchema,
        (await this.octokit.repos.get({ owner: ref.owner, repo: ref.repo })).data,
        "repository",
      ),
    );
    if (!settings.ok) return settings;
    const flag: Record<MergeMethod, boolean | null | undefined> = {
      merge: settings.value.allow_merge_commit,
      squash: settings.value.allow_squash_merge,
      rebase: settings.value.allow_rebase_merge,
    };
    // A flag GitHub does not disclose (token without admin/push) is not treated as disallowed;
    // GitHub itself rejects a disallowed method with 405, which maps to conflict.
    const chosen = preferences.find((method) => flag[method] !== false);
    return chosen
      ? ok(chosen)
      : err({
          kind: "conflict",
          reason: `repository allows none of the configured merge methods (${preferences.join(", ")})`,
        });
  }

  async merge(ref: PrRef, options: MergeOptions): Promise<Result<MergeResult, DomainError>> {
    if (options.method !== undefined && !isMergeMethod(options.method)) {
      return invalid("mergeMethod", "unknown merge method");
    }
    if (!SHA_PATTERN.test(options.sha)) return invalid("sha", "malformed commit SHA");
    const method = await this.resolveMergeMethod(ref, options.method);
    if (!method.ok) return method;
    const result = await this.guard(
      "pull_request",
      async () => {
        const { data } = await this.octokit.pulls.merge({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
          merge_method: method.value,
          sha: options.sha,
        });
        return parse(mergeResponseSchema, data, "merge");
      },
      true,
    );
    if (!result.ok) return result;
    if (!result.value.merged) {
      return err({ kind: "conflict", reason: "GitHub did not complete the merge" });
    }
    return ok({ merged: true, sha: result.value.sha });
  }
}
