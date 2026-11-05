import { missingPermissions } from "../../domain/settings/permissions";
import { checkRepoAddable, MAX_REPOS, parseRepoEntry } from "../../domain/settings/repo-entry";
import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { RepoCheckResult } from "../../ports/github-verifier";
import type { SettingsDeps } from "./deps";
import {
  buildSettingsView,
  FORBIDDEN_NON_USER,
  resolveGithubToken,
  toRepoView,
  type RepoView,
  type SettingsView,
} from "./view";

export type AddRepoResult = {
  view: SettingsView;
  added: RepoView;
  /** Permissions known to be missing (saved anyway, FR-GITHUB-07). */
  warnings: string[];
};

/**
 * FR-GITHUB-07: validate → check access with the stored token → store GitHub's spelling.
 * No access is `forbidden` (403); readable without write is saved with warnings.
 */
export async function addRepo(
  deps: SettingsDeps,
  actor: Actor,
  input: { repo: unknown },
): Promise<Result<AddRepoResult, DomainError>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);

  const parsed = parseRepoEntry(input.repo);
  if (!parsed.ok) return parsed;
  const addable = checkRepoAddable(parsed.value, await deps.githubRepos.listRepos());
  if (!addable.ok) return addable;

  const token = await resolveGithubToken(deps);
  if (!token.ok) return token;
  const row = await deps.githubCredentials.get();
  const info = row
    ? { tokenKind: row.meta.tokenKind, scopes: row.meta.scopes }
    : { tokenKind: "fine_grained" as const, scopes: null };

  const checked = await deps.githubVerifier.checkRepo(
    token.value,
    { owner: parsed.value.owner, repo: parsed.value.repo },
    info,
  );
  if (!checked.ok) {
    if (checked.error.kind === "not_found" || checked.error.kind === "forbidden") {
      // The name passed the format check, so it is safe to show.
      return err({
        kind: "forbidden",
        reason: `The token cannot access ${parsed.value.canonical}.`,
      });
    }
    return checked;
  }

  const stored = await storeRepo(deps, actor.userId, checked.value);
  if (!stored.ok) return stored;

  return ok({
    view: await buildSettingsView(deps),
    added: toRepoView(stored.value),
    warnings: missingPermissions(checked.value.permissions),
  });
}

/**
 * Stores a checked repo in GitHub's spelling with its event (one store transaction).
 * `deps.githubRepos` may be bound to an outer transaction (first-run setup).
 */
export function storeRepo(
  deps: Pick<SettingsDeps, "ids" | "clock" | "githubRepos">,
  userId: string,
  checked: RepoCheckResult,
) {
  const now = deps.clock.now();
  const eventId = deps.ids.uuid();
  return deps.githubRepos.addRepo(
    {
      owner: checked.owner,
      repo: checked.repo,
      canonical: checked.canonical,
      access: "ok",
      permissions: checked.permissions,
      checkedAt: now,
      addedAt: now,
      addedBy: userId,
    },
    {
      max: MAX_REPOS,
      // Recorded in the same transaction as the insert.
      event: (added) => ({
        id: eventId,
        type: "github_repo_added",
        actor: { kind: "user", id: userId },
        at: now,
        source: "web",
        detail: { repo: added.canonical },
      }),
    },
  );
}

/** FR-GITHUB-07. Needs no token. Case-insensitive. Delete and event are atomic. */
export async function removeRepo(
  deps: SettingsDeps,
  actor: Actor,
  input: { repo: unknown },
): Promise<Result<SettingsView, DomainError>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  const parsed = parseRepoEntry(input.repo);
  if (!parsed.ok) return parsed;
  const eventId = deps.ids.uuid();
  const now = deps.clock.now();
  const removed = await deps.githubRepos.removeRepo(parsed.value.canonical, (row) => ({
    id: eventId,
    type: "github_repo_removed",
    actor: { kind: "user", id: actor.userId },
    at: now,
    source: "web",
    detail: { repo: row.canonical },
  }));
  if (!removed) return err({ kind: "not_found", entity: "repository" });
  return ok(await buildSettingsView(deps));
}
