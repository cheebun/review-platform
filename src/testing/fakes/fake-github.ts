import { summarizeChecks } from "../../adapters/github/checks";
import { assembleDiff, PrChangedError, type DiffSource } from "../../adapters/github/diff-recovery";
import type { PrRef } from "../../domain/github/pr-ref";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import {
  ACCESSIBLE_REPOS_MAX_PAGES,
  ACCESSIBLE_REPOS_PAGE_SIZE,
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
  OpenPullRequest,
  type PullRequestDiff,
  type PullRequestMeta,
  type RepoRef,
  type ReviewState,
  type SubmitReviewInput,
} from "../../ports/github";
import {
  GithubWorld,
  type Fault,
  type PrRead,
  type WorldPr,
  type WorldReview,
} from "../http/github/world";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same path-safe commit reference rule as the Octokit adapter. */
const SHA_PATTERN = /^[0-9A-Za-z]{1,64}$/;

const isMergeMethod = (value: unknown): value is MergeMethod =>
  typeof value === "string" && (MERGE_METHODS as readonly string[]).includes(value);

const invalid = (field: string, message: string) =>
  Promise.resolve(err<DomainError>({ kind: "validation", field, message }));

export type FakeGitHubOptions = {
  /**
   * Merge methods in order of preference, as configured for the Octokit adapter. The first one
   * the repository allows (`world.setMergeSettings`) is used. Default `["merge"]`, the contract
   * harness's configuration; `[]` makes a merge without a per-call method a `validation` error.
   */
  mergeMethods?: readonly MergeMethod[];
};

const faultToError = (fault: Fault): DomainError => {
  switch (fault.kind) {
    case "rate_limited":
      return { kind: "rate_limited", retryAfterMs: fault.retryAfterSec * 1000 };
    case "bad_gateway":
      return { kind: "upstream", service: "github", retryable: true };
    case "forbidden":
    case "unauthorized":
      return { kind: "forbidden", reason: "GitHub rejected the credentials or permissions" };
  }
};

const notFound = (entity = "pull_request"): DomainError => ({ kind: "not_found", entity });

const metaOf = (read: PrRead, world: GithubWorld): PullRequestMeta => {
  const { pr } = read;
  return {
    title: pr.title,
    body: pr.body,
    author: pr.author,
    base: pr.base,
    head: pr.head,
    sha: pr.headSha,
    baseSha: pr.baseSha,
    state: pr.state,
    merged: pr.merged,
    draft: pr.draft,
    changedFiles: pr.reportedChangedFiles ?? world.fileCount(pr),
    htmlUrl: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    mergeable: read.mergeable,
    mergeableState: read.mergeable === null ? "unknown" : toMergeableState(read.mergeableState),
  };
};

/**
 * In-memory GitHub with real behaviour: merge flips the PR to merged/closed, comments and
 * reviews persist and can be found by marker, head SHA changes are scripted through `world`.
 * Seed and script it through `fake.world` (see `GithubWorld`).
 */
export class FakeGitHub implements GitHubPort {
  private readonly mergeMethods: readonly MergeMethod[];

  constructor(
    readonly world: GithubWorld = new GithubWorld(),
    options: FakeGitHubOptions = {},
  ) {
    const methods = options.mergeMethods ?? ["merge"];
    for (const method of methods) {
      if (!isMergeMethod(method)) throw new Error(`unknown merge method: ${String(method)}`);
    }
    this.mergeMethods = [...new Set(methods)];
  }

  /** Records the call, applies a scripted fault, and turns a thrown PrChangedError into conflict. */
  private async run<T>(
    operation: string,
    body: () => T | Promise<T>,
  ): Promise<Result<T, DomainError>> {
    this.world.record(operation);
    const fault = this.world.takeFault();
    if (fault) return err(faultToError(fault));
    try {
      return ok(await body());
    } catch (error) {
      if (error instanceof PrChangedError) {
        return err({
          kind: "conflict",
          reason: "pull request changed while its diff was being read",
        });
      }
      if (error instanceof NotFound) return err(notFound(error.entity));
      if (error instanceof Conflict) return err({ kind: "conflict", reason: error.message });
      return err({ kind: "upstream", service: "github", retryable: true });
    }
  }

  private pr(ref: PrRef): WorldPr {
    const pr = this.world.getPr(ref);
    if (!pr) throw new NotFound("pull_request");
    return pr;
  }

  listOpenPullRequests(repo: RepoRef, options: ListOpenOptions) {
    return this.run("list", (): OpenPullRequest[] => {
      const allow = new Set(options.authors.map((a) => a.toLowerCase()));
      const cutoff = options.now.getTime() - options.maxAgeDays * DAY_MS;
      return this.world
        .listPrs(repo.owner, repo.repo)
        .filter(
          (pr) =>
            !pr.draft && allow.has(pr.author.toLowerCase()) && Date.parse(pr.updatedAt) >= cutoff,
        )
        .map((pr) => ({
          number: pr.number,
          title: pr.title,
          author: pr.author,
          htmlUrl: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
          draft: false,
          updatedAt: pr.updatedAt,
          base: pr.base,
          head: pr.head,
          approved: pr.reviewDecision === "APPROVED",
        }));
    });
  }

  private read(ref: PrRef): PrRead {
    const read = this.world.readPr(ref);
    if (!read) throw new NotFound("pull_request");
    return read;
  }

  /** Same re-read rule as the adapter, without the backoff delay (the fake has no clock). */
  async getPullRequest(
    ref: PrRef,
    options: GetPullRequestOptions = {},
  ): Promise<Result<PullRequestMeta, DomainError>> {
    const first = await this.run("getPullRequest", () => metaOf(this.read(ref), this.world));
    if (!first.ok || !options.awaitMergeable) return first;
    let meta = first.value;
    for (let reads = 1; reads < MERGEABLE_MAX_READS && pendingMergeable(meta); reads++) {
      const next = await this.run("getPullRequest", () => metaOf(this.read(ref), this.world));
      if (!next.ok) break;
      meta = next.value;
    }
    return ok(meta);
  }

  getAuthenticatedLogin() {
    return this.run("getAuthenticatedLogin", () => this.world.login);
  }

  /** Same page cap as the adapter; the fake has no clock, so the time budget never applies. */
  listAccessibleRepos(_options: ListAccessibleReposOptions = {}) {
    return this.run("listAccessibleRepos", (): AccessibleRepoList => {
      const all = this.world.listAccessibleRepos();
      const cap = ACCESSIBLE_REPOS_MAX_PAGES * ACCESSIBLE_REPOS_PAGE_SIZE;
      return {
        repos: all.slice(0, cap).map((r) => ({ ...r })),
        truncated: all.length > cap,
      };
    });
  }

  getDiff(ref: PrRef): Promise<Result<PullRequestDiff, DomainError>> {
    const world = this.world;
    const source: DiffSource = {
      getMeta: async () => metaOf(this.read(ref), world),
      listFiles: async () => {
        this.pr(ref);
        return world.readFiles(ref);
      },
      mergeBase: async () => {
        world.record("compare");
        if (world.failMergeBase) throw new Error("merge base unavailable");
        return world.mergeBase;
      },
      fileShaAt: async (path) => {
        const sha = world.fileShaAtMergeBase(path);
        if (!sha) throw new Error("file not found at the merge base");
        return sha;
      },
      readBlob: async (sha) => {
        world.record("blob");
        if (world.failBlobs) throw new Error("blob source unavailable");
        const bytes = world.blob(sha);
        if (!bytes) throw new Error("blob not found");
        const content = world.truncateBlobs ? bytes.subarray(0, 1) : bytes;
        return { sha, encoding: "base64", size: bytes.length, content: content.toString("base64") };
      },
    };
    return this.run("getDiff", () => assembleDiff(source));
  }

  findCommentByMarker(ref: PrRef, marker: string) {
    return this.run("findCommentByMarker", () => {
      this.pr(ref);
      const hit = this.world.listComments(ref).find((c) => c.body.includes(marker));
      return hit ? { id: hit.id } : null;
    });
  }

  createComment(ref: PrRef, body: string) {
    return this.run("createComment", () => {
      this.pr(ref);
      return { id: this.world.addComment(ref, body).id };
    });
  }

  findReviewByMarker(
    ref: PrRef,
    marker: string,
    filter: { commitId?: string; state?: ReviewState } = {},
  ) {
    return this.run("findReviewByMarker", (): FoundReview | null => {
      this.pr(ref);
      const login = this.world.login.toLowerCase();
      const hit = this.world
        .listReviews(ref)
        .filter(
          (r) =>
            r.user.toLowerCase() === login &&
            r.body.includes(marker) &&
            (filter.commitId === undefined || r.commitId === filter.commitId) &&
            (filter.state === undefined || r.state === filter.state),
        )
        .toSorted((a, b) => b.id - a.id)[0];
      return hit ? { id: hit.id, commitId: hit.commitId, state: hit.state as ReviewState } : null;
    });
  }

  submitReview(ref: PrRef, input: SubmitReviewInput) {
    return this.run("submitReview", () => {
      const pr = this.pr(ref);
      const body = input.body?.trim() || (input.event === "APPROVE" ? "" : "<!-- -->");
      const state =
        input.event === "APPROVE"
          ? "APPROVED"
          : input.event === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED";
      return {
        id: this.world.addReview(ref, { body, state, commitId: input.commitId ?? pr.headSha }).id,
      };
    });
  }

  getChecks(repo: RepoRef, sha: string): Promise<Result<ChecksSummary, DomainError>> {
    // Validated before any "request", like the adapter: no call is recorded, no fault consumed.
    if (!SHA_PATTERN.test(sha)) return invalid("sha", "malformed commit SHA");
    return this.run("getChecks", () =>
      summarizeChecks(
        // The adapter asks GitHub for `filter=latest`: only the newest run per name.
        this.world.listCheckRuns(repo, sha, true),
        this.world.listCommitStatuses(repo, sha),
      ),
    );
  }

  hasApproval(ref: PrRef, sha: string): Promise<Result<boolean, DomainError>> {
    if (!SHA_PATTERN.test(sha)) return invalid("sha", "malformed commit SHA");
    return this.run("hasApproval", () => {
      this.pr(ref);
      const login = this.world.login.toLowerCase();
      // Only APPROVED and CHANGES_REQUESTED change the review decision; dismissed, pending and
      // comment-only reviews are ignored.
      const latest = this.world
        .listReviews(ref)
        .filter(
          (r) =>
            r.user.toLowerCase() === login &&
            (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"),
        )
        .reduce<WorldReview | null>((a, b) => (a && a.id > b.id ? a : b), null);
      return latest?.state === "APPROVED" && latest.commitId === sha;
    });
  }

  /** The per-call method, else the first configured one the repository allows. */
  private resolveMergeMethod(ref: PrRef, requested: MergeMethod | undefined): MergeMethod {
    if (requested !== undefined) return requested;
    if (this.mergeMethods.length === 1) return this.mergeMethods[0]!;
    const flags = this.world.mergeSettings(ref);
    // An undisclosed flag (null) is not treated as disallowed, as in the adapter.
    const chosen = this.mergeMethods.find((method) => flags[method] !== false);
    if (!chosen) {
      throw new Conflict(
        `repository allows none of the configured merge methods (${this.mergeMethods.join(", ")})`,
      );
    }
    return chosen;
  }

  merge(ref: PrRef, options: MergeOptions): Promise<Result<MergeResult, DomainError>> {
    if (options.method !== undefined && !isMergeMethod(options.method)) {
      return invalid("mergeMethod", "unknown merge method");
    }
    if (!SHA_PATTERN.test(options.sha)) return invalid("sha", "malformed commit SHA");
    if (options.method === undefined && this.mergeMethods.length === 0) {
      return invalid("mergeMethod", "no merge method configured");
    }
    return this.run("merge", (): MergeResult => {
      const method = this.resolveMergeMethod(ref, options.method);
      const outcome = this.world.merge(ref, options.sha, method);
      if (outcome.kind === "missing") throw new NotFound("pull_request");
      if (outcome.kind === "method_not_allowed") {
        throw new Conflict(`merge method ${method} is not allowed for this repository`);
      }
      if (outcome.kind !== "merged") {
        throw new Conflict("pull request cannot be merged at this commit");
      }
      return { merged: true, sha: outcome.sha };
    });
  }
}

/** Open, unmerged and GitHub has not computed `mergeable` yet. */
const pendingMergeable = (meta: PullRequestMeta) =>
  meta.mergeable === null && meta.state === "open" && !meta.merged;

class NotFound extends Error {
  constructor(readonly entity: string) {
    super("not found");
  }
}

class Conflict extends Error {}
