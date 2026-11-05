import {
  githubAvailability,
  toTokenDisplay,
  type GithubAvailability,
  type TokenDisplay,
} from "../../domain/settings/github-credential";
import {
  missingPermissions,
  repoHealth,
  type RepoAccess,
  type RepoHealth,
  type RepoPermissions,
} from "../../domain/settings/permissions";
import { MAX_REPOS } from "../../domain/settings/repo-entry";
import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { StoredCredential } from "../../ports/credential-store";
import type { StoredRepo } from "../../ports/settings-repo";
import type { GithubReadDeps, SettingsDeps } from "./deps";

/** One repo as the client sees it. All dates are ISO strings. */
export type RepoView = {
  canonical: string;
  access: RepoAccess;
  permissions: RepoPermissions | null;
  health: RepoHealth;
  /** Permissions known to be missing, e.g. "contents:write". */
  missing: string[];
  checkedAt: string | null;
  addedAt: string;
};

/** The settings page model. Never contains the token or its ciphertext. */
export type SettingsView = {
  availability: GithubAvailability["state"];
  token: TokenDisplay | null;
  repos: RepoView[];
  maxRepos: number;
};

export const FORBIDDEN_NON_USER: DomainError = {
  kind: "forbidden",
  reason: "Only a signed-in user may change settings.",
};

export function toRepoView(r: StoredRepo): RepoView {
  return {
    canonical: r.canonical,
    access: r.access,
    permissions: r.permissions ? structuredClone(r.permissions) : null,
    health: repoHealth({ access: r.access, permissions: r.permissions }),
    missing: r.permissions ? missingPermissions(r.permissions) : [],
    checkedAt: r.checkedAt ? r.checkedAt.toISOString() : null,
    addedAt: r.addedAt.toISOString(),
  };
}

type Unlocked = { row: StoredCredential; token: string | null };

async function unlock(deps: GithubReadDeps): Promise<Unlocked | null> {
  const row = await deps.githubCredentials.get();
  if (!row) return null;
  const plain = deps.tokenCipher.decrypt(row.encrypted);
  return { row, token: plain.ok ? plain.value : null };
}

const availabilityOf = (u: Unlocked | null): GithubAvailability =>
  githubAvailability(u ? { meta: u.row.meta, decrypts: u.token !== null } : null);

/** FR-GITHUB-05: 未配置 / 需要重新设置 / 就绪. Never returns the token. */
export async function getGithubAvailability(deps: GithubReadDeps): Promise<GithubAvailability> {
  return availabilityOf(await unlock(deps));
}

/**
 * The plaintext token, for server-side GitHub calls only. Callers must never return or log it.
 * `not_configured github` (with `reason: "needs_reset"` when the row cannot be decrypted).
 */
export async function resolveGithubToken(
  deps: GithubReadDeps,
): Promise<Result<string, DomainError>> {
  const u = await unlock(deps);
  if (!u) return err({ kind: "not_configured", feature: "github" });
  if (u.token === null) {
    return err({ kind: "not_configured", feature: "github", reason: "needs_reset" });
  }
  return ok(u.token);
}

/** Builds the view from storage. Internal: callers check the actor first. */
export async function buildSettingsView(deps: SettingsDeps): Promise<SettingsView> {
  const [u, repos] = await Promise.all([unlock(deps), deps.githubRepos.listRepos()]);
  return {
    availability: availabilityOf(u).state,
    token: u ? toTokenDisplay(u.row.meta) : null,
    repos: repos.map(toRepoView),
    maxRepos: MAX_REPOS,
  };
}

export async function getSettingsView(
  deps: SettingsDeps,
  actor: Actor,
): Promise<Result<SettingsView, DomainError>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  return ok(await buildSettingsView(deps));
}
