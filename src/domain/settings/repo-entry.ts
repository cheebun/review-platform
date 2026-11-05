import { err, ok, type DomainError, type Result } from "../shared/result";

/** One `owner/repo` in the settings repo list. `canonical` is `owner/repo` as GitHub spells it. */
export type RepoEntry = { owner: string; repo: string; canonical: string };

/** Upper bound of the repo list (FR-GITHUB-07, assumed). */
export const MAX_REPOS = 50;

/** Longer input is rejected before the regex runs. */
const MAX_INPUT_LENGTH = 200;

/** The decided format (FR-GITHUB-07). Anchored, so `foo/bar/baz` and `foo` fail. */
const REPO_ENTRY_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const invalid = (message: string): { ok: false; error: DomainError } =>
  err({ kind: "validation", field: "repo", message });

/** Trims, then checks the format. The error never echoes the input. */
export function parseRepoEntry(input: unknown): Result<RepoEntry, DomainError> {
  if (typeof input !== "string") return invalid("Repository must be a string.");
  const value = input.trim();
  if (value.length === 0 || value.length > MAX_INPUT_LENGTH || !REPO_ENTRY_RE.test(value)) {
    return invalid('Repository must have the form "owner/repo".');
  }
  const [owner, repo] = value.split("/");
  return ok({ owner, repo, canonical: `${owner}/${repo}` });
}

/** Case-insensitive identity of a repo entry, as stored in the unique key. */
export function repoKey(canonical: string): string {
  return canonical.toLowerCase();
}

/** Deduplication (case-insensitive) first, then the size limit. Pure. */
export function checkRepoAddable(
  candidate: RepoEntry,
  existing: readonly { canonical: string }[],
): Result<void, DomainError> {
  const key = repoKey(candidate.canonical);
  if (existing.some((e) => repoKey(e.canonical) === key)) {
    return invalid("This repository is already in the list.");
  }
  if (existing.length >= MAX_REPOS) {
    return invalid(`The list already holds the maximum of ${MAX_REPOS} repositories.`);
  }
  return ok(undefined);
}
