import { createHash } from "node:crypto";

/**
 * In-memory model of a GitHub host. Shared by `FakeGitHub` (port level) and the msw handlers
 * (HTTP level), so both implementations of the contract see exactly the same data.
 * Tokens and identities here are fake.
 */

export type WorldPr = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  updatedAt: string;
  reviewDecision: string | null;
  /** Overrides `changed_files` to simulate a truncated file list. */
  reportedChangedFiles?: number;
  /** Set by a successful merge: the method GitHub merged with. */
  mergeMethod?: string;
  /** GitHub's `mergeable` once computed. Default true; false makes a merge fail. */
  mergeable: boolean | null;
  /** GitHub's raw `mergeable_state` once computed (any string, as GitHub may add values). */
  mergeableState: string;
};

/** What one read of the PR reports: while GitHub is computing, `null` and `unknown`. */
export type PrRead = { pr: WorldPr; mergeable: boolean | null; mergeableState: string };

export type SeedFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  /** Present: GitHub returns this patch inline. Absent: the adapter must recover it from blobs. */
  patch?: string;
  before?: string | Buffer;
  after?: string | Buffer;
  additions?: number;
  deletions?: number;
};

export type WorldFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
  sha: string | null;
  additions: number;
  deletions: number;
};

export type WorldComment = { id: number; body: string; user: string };
export type WorldReview = {
  id: number;
  user: string;
  body: string;
  state: string;
  commitId: string;
};

/** A check run as GitHub reports it; `status` other than `completed` means not finished. */
export type WorldCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
};
export type WorldCommitStatus = { id: number; context: string; state: string };

/** Repository merge flags (`allow_*_merge`). `null` means GitHub does not disclose the flag. */
export type WorldMergeSettings = {
  merge: boolean | null;
  squash: boolean | null;
  rebase: boolean | null;
};

export type Fault =
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "bad_gateway" }
  | { kind: "forbidden" }
  /** 401: the token itself is rejected (revoked or expired). */
  | { kind: "unauthorized" };

/** A repository the token can see on `GET /user/repos`. */
export type WorldAccessibleRepo = {
  fullName: string;
  private: boolean;
  archived: boolean;
  /** `permissions.push` as GitHub reports it for the token's account. */
  canPush: boolean;
};

export type MergeOutcome =
  | { kind: "merged"; sha: string }
  | { kind: "missing" }
  | { kind: "sha_mismatch" }
  | { kind: "not_mergeable" }
  | { kind: "method_not_allowed" };

type Key = { owner: string; repo: string; number: number };
const keyOf = (r: Key) => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}#${r.number}`;
type RepoKey = { owner: string; repo: string };
const repoKeyOf = (r: RepoKey) => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`;
const commitKeyOf = (r: RepoKey, sha: string) => `${repoKeyOf(r)}@${sha}`;

const gitBlobSha = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export class GithubWorld {
  login = "reviewer-bot";
  /** Merge base reported by the compare endpoint. */
  mergeBase = "merge-base-sha";
  failMergeBase = false;
  failBlobs = false;
  truncateBlobs = false;
  /** Every request/port call, for call-count assertions. */
  readonly calls: { operation: string; detail?: string }[] = [];

  private readonly prs = new Map<string, WorldPr>();
  private readonly files = new Map<string, WorldFile[]>();
  private readonly blobs = new Map<string, Buffer>();
  private readonly oldFiles = new Map<string, string>();
  private readonly comments = new Map<string, WorldComment[]>();
  private readonly reviews = new Map<string, WorldReview[]>();
  private readonly checkRuns = new Map<string, WorldCheckRun[]>();
  private readonly statuses = new Map<string, WorldCommitStatus[]>();
  private readonly mergeFlags = new Map<string, WorldMergeSettings>();
  private readonly faults: Fault[] = [];
  private readonly accessible: WorldAccessibleRepo[] = [];
  private headChange?: { key: string; sha: string };
  private readonly computing = new Map<string, number>();
  private readFault?: { afterReads: number; fault: Fault };
  private prReads = 0;
  private seq = 1000;

  record(operation: string, detail?: string): void {
    this.calls.push({ operation, detail });
  }

  count(operation: string): number {
    return this.calls.filter((c) => c.operation === operation).length;
  }

  // --- seeding -----------------------------------------------------------------------------

  addPr(seed: Partial<WorldPr> & Key): WorldPr {
    const pr: WorldPr = {
      title: `PR ${seed.number}`,
      body: "",
      author: "author-a",
      base: "main",
      head: `branch-${seed.number}`,
      headSha: `head-sha-${seed.number}`,
      baseSha: "base-sha",
      state: "open",
      merged: false,
      draft: false,
      updatedAt: "2026-01-01T00:00:00Z",
      reviewDecision: null,
      mergeable: true,
      mergeableState: "clean",
      ...seed,
    };
    this.prs.set(keyOf(pr), pr);
    return pr;
  }

  setFiles(ref: Key, seeds: SeedFile[]): void {
    const store = (content: string | Buffer) => {
      const bytes = Buffer.from(content);
      const sha = gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      return sha;
    };
    const resolved = seeds.map((s): WorldFile => {
      const oldSha = s.before == null ? undefined : store(s.before);
      if (oldSha) this.oldFiles.set(s.previous_filename ?? s.filename, oldSha);
      const sha = s.after == null ? (oldSha ?? null) : store(s.after);
      return {
        filename: s.filename,
        previous_filename: s.previous_filename,
        status: s.status,
        patch: s.patch,
        sha,
        additions: s.additions ?? 0,
        deletions: s.deletions ?? 0,
      };
    });
    this.files.set(keyOf(ref), resolved);
  }

  addComment(ref: Key, body: string, user = this.login): WorldComment {
    const comment = { id: ++this.seq, body, user };
    const list = this.comments.get(keyOf(ref)) ?? [];
    list.push(comment);
    this.comments.set(keyOf(ref), list);
    return comment;
  }

  addReview(
    ref: Key,
    input: { user?: string; body?: string; state: string; commitId: string },
  ): WorldReview {
    const review = {
      id: ++this.seq,
      user: input.user ?? this.login,
      body: input.body ?? "",
      ...input,
    };
    const list = this.reviews.get(keyOf(ref)) ?? [];
    list.push(review);
    this.reviews.set(keyOf(ref), list);
    return review;
  }

  /** A check run at `sha`. Later runs get higher ids, so a re-run supersedes the earlier one. */
  addCheckRun(
    repo: RepoKey,
    sha: string,
    input: { name: string; status?: string; conclusion?: string | null },
  ): WorldCheckRun {
    const run: WorldCheckRun = {
      id: ++this.seq,
      name: input.name,
      status: input.status ?? "completed",
      conclusion: input.conclusion === undefined ? "success" : input.conclusion,
    };
    const key = commitKeyOf(repo, sha);
    this.checkRuns.set(key, [...(this.checkRuns.get(key) ?? []), run]);
    return run;
  }

  /** A commit status at `sha`. Later statuses get higher ids (GitHub keeps every one). */
  addCommitStatus(
    repo: RepoKey,
    sha: string,
    input: { context: string; state: string },
  ): WorldCommitStatus {
    const status = { id: ++this.seq, ...input };
    const key = commitKeyOf(repo, sha);
    this.statuses.set(key, [...(this.statuses.get(key) ?? []), status]);
    return status;
  }

  /** Overrides some of the repository's merge flags; the rest stay allowed. */
  setMergeSettings(repo: RepoKey, flags: Partial<WorldMergeSettings>): void {
    this.mergeFlags.set(repoKeyOf(repo), { ...this.mergeSettings(repo), ...flags });
  }

  /** A repository the token can access. Defaults: public, not archived, push allowed. */
  addAccessibleRepo(
    seed: Partial<WorldAccessibleRepo> & { fullName: string },
  ): WorldAccessibleRepo {
    const repo: WorldAccessibleRepo = { private: false, archived: false, canPush: true, ...seed };
    this.accessible.push(repo);
    return repo;
  }

  /** The head of `ref` moves to `sha` (a new push). */
  pushHead(ref: Key, sha: string): void {
    const pr = this.prs.get(keyOf(ref));
    if (pr) pr.headSha = sha;
  }

  /** The head of `ref` moves to `sha` the first time its file list is read. */
  pushHeadOnFilesRead(ref: Key, sha: string): void {
    this.headChange = { key: keyOf(ref), sha };
  }

  /** GitHub reports `mergeable: null` for the next `reads` reads of `ref` (still computing). */
  setMergeableComputing(ref: Key, reads: number): void {
    this.computing.set(keyOf(ref), reads);
  }

  /** Schedules `fault` for the request that follows the `afterReads`-th PR read. */
  failAfterReads(afterReads: number, fault: Fault): void {
    this.readFault = { afterReads, fault };
  }

  failNext(fault: Fault, times = 1): void {
    for (let i = 0; i < times; i++) this.faults.push(fault);
  }

  takeFault(): Fault | undefined {
    return this.faults.shift();
  }

  // --- reads / writes ----------------------------------------------------------------------

  listPrs(owner: string, repo: string): WorldPr[] {
    const prefix = `${owner.toLowerCase()}/${repo.toLowerCase()}#`;
    return [...this.prs.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, pr]) => pr)
      .filter((pr) => pr.state === "open")
      .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /** Every accessible repository, sorted by full name (case-insensitive) as `sort=full_name`. */
  listAccessibleRepos(): WorldAccessibleRepo[] {
    return this.accessible.toSorted((a, b) =>
      a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase()),
    );
  }

  getPr(ref: Key): WorldPr | undefined {
    return this.prs.get(keyOf(ref));
  }

  /** One PR read as GitHub answers it (`pr_read` is recorded): counts down "still computing". */
  readPr(ref: Key): PrRead | undefined {
    const pr = this.prs.get(keyOf(ref));
    if (!pr) return undefined;
    this.record("pr_read");
    this.prReads++;
    if (this.readFault && this.prReads >= this.readFault.afterReads) {
      this.faults.push(this.readFault.fault);
      this.readFault = undefined;
    }
    const left = this.computing.get(keyOf(ref)) ?? 0;
    if (left > 0) {
      this.computing.set(keyOf(ref), left - 1);
      return { pr, mergeable: null, mergeableState: "unknown" };
    }
    return { pr, mergeable: pr.mergeable, mergeableState: pr.mergeableState };
  }

  readFiles(ref: Key): WorldFile[] {
    const key = keyOf(ref);
    if (this.headChange?.key === key) {
      this.pushHead(ref, this.headChange.sha);
      this.headChange = undefined;
    }
    return this.files.get(key) ?? [];
  }

  fileCount(ref: Key): number {
    return this.files.get(keyOf(ref))?.length ?? 0;
  }

  blob(sha: string): Buffer | undefined {
    return this.blobs.get(sha);
  }

  fileShaAtMergeBase(path: string): string | undefined {
    return this.oldFiles.get(path);
  }

  listComments(ref: Key): WorldComment[] {
    return this.comments.get(keyOf(ref)) ?? [];
  }

  listReviews(ref: Key): WorldReview[] {
    return this.reviews.get(keyOf(ref)) ?? [];
  }

  /**
   * Check runs at `sha`. `latest` mirrors GitHub's `filter=latest`: only the newest run per name.
   */
  listCheckRuns(repo: RepoKey, sha: string, latest: boolean): WorldCheckRun[] {
    const runs = this.checkRuns.get(commitKeyOf(repo, sha)) ?? [];
    if (!latest) return [...runs];
    const newest = new Map<string, WorldCheckRun>();
    for (const run of runs) {
      const seen = newest.get(run.name);
      if (!seen || run.id > seen.id) newest.set(run.name, run);
    }
    return [...newest.values()].toSorted((a, b) => a.id - b.id);
  }

  /** Every commit status at `sha`, newest first, as GitHub lists them. */
  listCommitStatuses(repo: RepoKey, sha: string): WorldCommitStatus[] {
    return (this.statuses.get(commitKeyOf(repo, sha)) ?? []).toSorted((a, b) => b.id - a.id);
  }

  mergeSettings(repo: RepoKey): WorldMergeSettings {
    return this.mergeFlags.get(repoKeyOf(repo)) ?? { merge: true, squash: true, rebase: true };
  }

  merge(ref: Key, sha: string, method = "merge"): MergeOutcome {
    const pr = this.prs.get(keyOf(ref));
    if (!pr) return { kind: "missing" };
    const flags = this.mergeSettings(ref) as Record<string, boolean | null | undefined>;
    if (flags[method] === false) return { kind: "method_not_allowed" };
    if (sha !== pr.headSha) return { kind: "sha_mismatch" };
    if (pr.state !== "open" || pr.merged || pr.draft || pr.mergeable === false) {
      return { kind: "not_mergeable" };
    }
    pr.state = "closed";
    pr.merged = true;
    pr.mergeMethod = method;
    return { kind: "merged", sha: `merge-commit-of-${pr.headSha}` };
  }
}
