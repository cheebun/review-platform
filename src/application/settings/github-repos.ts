import type { Actor } from "../../domain/shared/actor";
import { err, ok, type Result } from "../../domain/shared/result";
import type { GitHubPort, ListAccessibleReposOptions } from "../../ports/github";
import type { RateLimiter } from "../../ports/rate-limiter";
import type { GithubReadDeps } from "./deps";
import { FORBIDDEN_NON_USER, getGithubAvailability } from "./view";

/** Each listing reads up to 10 GitHub pages, so it is rate limited per user, as Slack's is. */
export const GITHUB_REPO_LIST_LIMIT = { limit: 30, windowMs: 600_000 } as const;

/** One repo the picker offers. Archived repos are never offered. */
export type AccessibleRepoOption = { fullName: string; private: boolean; canPush: boolean };
export type AccessibleRepoOptions = { repos: AccessibleRepoOption[]; truncated: boolean };

/** Field names match the container's `Ports`; `github` is the stored-token port. */
export type GithubRepoListDeps = GithubReadDeps & {
  github: Pick<GitHubPort, "listAccessibleRepos">;
  rateLimiter: RateLimiter;
};

/**
 * The repos the stored token can access, for the repo picker on /settings. Read-only. Without
 * a usable token it is `not_configured github` (with `needs_reset` when the row cannot be
 * decrypted), before any GitHub call or rate-limit hit. The result carries names and flags only.
 */
export async function listAccessibleGithubRepos(
  deps: GithubRepoListDeps,
  actor: Actor,
  options: ListAccessibleReposOptions = {},
): Promise<Result<AccessibleRepoOptions>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);

  const availability = await getGithubAvailability(deps);
  if (availability.state === "not_configured") {
    return err({ kind: "not_configured", feature: "github" });
  }
  if (availability.state === "needs_reset") {
    return err({ kind: "not_configured", feature: "github", reason: "needs_reset" });
  }

  const limit = await deps.rateLimiter.hit(`github-repos:${actor.userId}`, GITHUB_REPO_LIST_LIMIT);
  if (!limit.allowed) return err({ kind: "rate_limited", retryAfterMs: limit.retryAfterMs });

  const listed = await deps.github.listAccessibleRepos(options);
  if (!listed.ok) return listed;
  return ok({
    repos: listed.value.repos
      .filter((r) => !r.archived)
      .map((r) => ({ fullName: r.fullName, private: r.private, canPush: r.canPush })),
    truncated: listed.value.truncated,
  });
}
