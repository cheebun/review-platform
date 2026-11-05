import { parseTokenInput, tokenLast4 } from "../../domain/settings/github-credential";
import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { TokenInfo, VerifiedToken } from "../../ports/github-verifier";
import type { RepoCheck } from "../../ports/settings-repo";
import { mapLimit } from "../shared/map-limit";
import type { SettingsDeps } from "./deps";
import { buildSettingsView, FORBIDDEN_NON_USER, type SettingsView } from "./view";

/** FR-GITHUB-02: verifying a token hits GitHub, so saves are rate limited per user. */
export const TOKEN_SAVE_LIMIT = { limit: 5, windowMs: 600_000 } as const;

/** Repo re-checks in flight at once after a token change (each check is 5 GET requests). */
export const RECHECK_CONCURRENCY = 4;

/**
 * Re-checks every listed repo with `token` and stores the result. 404/403 means the token lost
 * access (`no_access`); any other failure (5xx, rate limit) is `unknown`, never a false negative.
 */
export async function recheckRepos(
  deps: SettingsDeps,
  token: string,
  info: TokenInfo,
): Promise<void> {
  const repos = await deps.githubRepos.listRepos();
  await mapLimit(repos, RECHECK_CONCURRENCY, async (r) => {
    const result = await deps.githubVerifier.checkRepo(
      token,
      { owner: r.owner, repo: r.repo },
      info,
    );
    const checkedAt = deps.clock.now();
    let check: RepoCheck;
    if (result.ok) {
      check = { access: "ok", permissions: result.value.permissions, checkedAt };
    } else if (result.error.kind === "not_found" || result.error.kind === "forbidden") {
      check = { access: "no_access", permissions: null, checkedAt };
    } else {
      deps.logger.warn("github repo re-check failed", {
        repo: r.canonical,
        error: result.error.kind,
      });
      check = { access: "unknown", permissions: r.permissions, checkedAt };
    }
    await deps.githubRepos.updateRepoCheck(r.canonical, check);
  });
}

/**
 * FR-GITHUB-02: validate → verify with GitHub → encrypt → store with its event (one transaction)
 * → re-check repos. If the event cannot be stored the token is not changed and the call rejects.
 * A token GitHub rejects is `forbidden` (403); nothing is stored. The token never appears
 * in a result, an event or a log entry.
 */
export async function saveGithubToken(
  deps: SettingsDeps,
  actor: Actor,
  input: { token: unknown },
): Promise<Result<SettingsView, DomainError>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);

  const limit = await deps.rateLimiter.hit(`github-token:${actor.userId}`, TOKEN_SAVE_LIMIT);
  if (!limit.allowed) return err({ kind: "rate_limited", retryAfterMs: limit.retryAfterMs });

  const parsed = parseTokenInput(input.token);
  if (!parsed.ok) return parsed;
  const token = parsed.value;

  const verified = await deps.githubVerifier.verifyToken(token);
  if (!verified.ok) {
    if (verified.error.kind === "forbidden") {
      return err({ kind: "forbidden", reason: "Token rejected by GitHub." });
    }
    return verified;
  }
  const user = verified.value;

  const { replaced } = await storeGithubToken(deps, actor.userId, token, user);
  deps.logger.info("github token saved", { login: user.login, replaced });

  await recheckRepos(deps, token, { tokenKind: user.tokenKind, scopes: user.scopes });
  return ok(await buildSettingsView(deps));
}

/**
 * Encrypts and stores a verified token with its event (one store transaction).
 * `deps.githubCredentials` may be bound to an outer transaction (first-run setup).
 */
export function storeGithubToken(
  deps: Pick<SettingsDeps, "ids" | "clock" | "tokenCipher" | "githubCredentials">,
  userId: string,
  token: string,
  user: VerifiedToken,
) {
  const last4 = tokenLast4(token);
  const eventId = deps.ids.uuid();
  const now = deps.clock.now();
  return deps.githubCredentials.save(
    {
      encrypted: deps.tokenCipher.encrypt(token),
      login: user.login,
      avatarUrl: user.avatarUrl,
      last4,
      tokenKind: user.tokenKind,
      scopes: user.scopes,
      savedAt: now,
      savedByUserId: userId,
    },
    (outcome) => ({
      id: eventId,
      type: outcome.replaced ? "github_token_replaced" : "github_token_saved",
      actor: { kind: "user", id: userId },
      at: now,
      source: "web",
      detail: { login: user.login, last4 },
    }),
  );
}

/** FR-GITHUB-04. The repo list is kept; GitHub features become 未配置. Delete and event are atomic. */
export async function removeGithubToken(
  deps: SettingsDeps,
  actor: Actor,
): Promise<Result<SettingsView, DomainError>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  const eventId = deps.ids.uuid();
  const now = deps.clock.now();
  const removed = await deps.githubCredentials.remove((meta) => ({
    id: eventId,
    type: "github_token_removed",
    actor: { kind: "user", id: actor.userId },
    at: now,
    source: "web",
    detail: { login: meta.login, last4: meta.last4 },
  }));
  if (removed) deps.logger.info("github token removed", { login: removed.login });
  return ok(await buildSettingsView(deps));
}
