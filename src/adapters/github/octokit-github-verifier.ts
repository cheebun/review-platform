import { Octokit } from "@octokit/rest";
import type { PermissionStatus, RepoPermissions } from "../../domain/settings/permissions";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type {
  GitHubVerifier,
  RepoCheckResult,
  TokenInfo,
  VerifiedToken,
} from "../../ports/github-verifier";
import { toDomainError } from "./errors";

export type OctokitGitHubVerifierOptions = {
  userAgent: string;
  baseUrl?: string;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Clock used only to turn `x-ratelimit-reset` into a delay. */
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const API_VERSION = "2022-11-28";

/** Octokit's RequestError, matched structurally (never by message). */
function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { name?: unknown; status?: unknown };
  return e.name === "HttpError" && typeof e.status === "number" ? e.status : null;
}

function parseScopes(header: unknown): string[] | null {
  if (typeof header !== "string") return null;
  return header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type RepoBody = {
  full_name: string;
  private: boolean;
  default_branch: string;
  permissions?: { push?: boolean; pull?: boolean };
  allow_merge_commit?: unknown;
  allow_squash_merge?: unknown;
  allow_rebase_merge?: unknown;
};

/**
 * Verifies a GitHub token with **read-only** requests only. No write is ever sent to probe a
 * permission. How each cell is determined (GitHub REST docs, apiVersion 2022-11-28):
 *
 * - Token kind: `X-OAuth-Scopes` is present for classic (and OAuth) tokens and lists their
 *   scopes. When it is absent the token is treated as fine-grained. GitHub has no endpoint that
 *   lists a fine-grained token's permissions.
 * - Access: `GET /repos/{o}/{r}` (Metadata: read). 404/403 means the token cannot see the repo.
 * - pull_requests:read: `GET /repos/{o}/{r}/pulls?per_page=1` (Pull requests: read).
 * - contents:read: `GET /repos/{o}/{r}/commits?per_page=1` (Contents: read). 409 is "repository
 *   is empty", which GitHub returns only after the permission check, so it counts as granted.
 * - checks:read: `GET /repos/{o}/{r}/commits/{default_branch}/check-runs?per_page=1`.
 * - statuses:read: `GET /repos/{o}/{r}/commits/{default_branch}/status` (Commit statuses: read).
 *   On these two, 404/409/422 (no such ref, empty repo) is `unverified`, not missing.
 * - contents:write, fine-grained: GET /repos returns the merge settings (`allow_merge_commit`,
 *   ...) only with "contents:read and contents:write". Present → granted. Absent while
 *   contents:read is granted → missing. Otherwise unverified.
 * - contents:write and pull_requests:write, classic: granted when the scopes include `repo` (or
 *   `public_repo` on a public repo) and the user's repo role has `push`; missing when the scope
 *   or `push` is absent; unverified when GitHub returns no `permissions` object.
 * - pull_requests:write, fine-grained: every endpoint that needs it is a write (POST, PATCH, PUT
 *   or DELETE), so it is always `unverified`.
 * - In all cases a user role without `push` makes contents:write missing.
 * - A probe that fails with 5xx, a timeout, a dropped connection or a rate limit is `unverified`.
 */
export class OctokitGitHubVerifier implements GitHubVerifier {
  private readonly now: () => number;

  constructor(private readonly options: OctokitGitHubVerifierOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** A client for one call. The token lives only in this object, never in logs or results. */
  private client(token: string): Octokit {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Octokit({
      auth: token,
      userAgent: this.options.userAgent,
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      request: {
        fetch: (input: string | URL | Request, init?: RequestInit) => {
          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
          return globalThis.fetch(input, { ...init, signal });
        },
      },
    });
  }

  private fail(error: unknown, entity: string): { ok: false; error: DomainError } {
    return err(toDomainError(error, { entity, now: this.now }));
  }

  async verifyToken(token: string): Promise<Result<VerifiedToken, DomainError>> {
    try {
      const res = await this.client(token).request("GET /user", {
        headers: { "x-github-api-version": API_VERSION },
      });
      const scopes = parseScopes(res.headers["x-oauth-scopes"]);
      return ok({
        login: res.data.login,
        avatarUrl: res.data.avatar_url,
        tokenKind: scopes === null ? "fine_grained" : "classic",
        scopes,
      });
    } catch (error) {
      return this.fail(error, "user");
    }
  }

  async checkRepo(
    token: string,
    target: { owner: string; repo: string },
    info: TokenInfo,
  ): Promise<Result<RepoCheckResult, DomainError>> {
    const octokit = this.client(token);
    const headers = { "x-github-api-version": API_VERSION };

    let body: RepoBody;
    try {
      const res = await octokit.request("GET /repos/{owner}/{repo}", {
        owner: target.owner,
        repo: target.repo,
        headers,
      });
      // Pick fields at once: the body also carries `temp_clone_token`, a credential.
      const d = res.data as unknown as RepoBody;
      body = {
        full_name: d.full_name,
        private: d.private,
        default_branch: d.default_branch,
        permissions: d.permissions,
        allow_merge_commit: d.allow_merge_commit,
        allow_squash_merge: d.allow_squash_merge,
        allow_rebase_merge: d.allow_rebase_merge,
      };
    } catch (error) {
      return this.fail(error, "repository");
    }

    const [owner, repo] = body.full_name.split("/");
    const probe = async (
      route: string,
      params: Record<string, unknown>,
      onNotFound: PermissionStatus,
      onConflict: PermissionStatus,
    ): Promise<PermissionStatus> => {
      try {
        await octokit.request(route, { owner, repo, per_page: 1, headers, ...params });
        return "granted";
      } catch (error) {
        const status = httpStatus(error);
        if (status === 401 || status === 403) {
          // A 403 that is a rate limit says nothing about the permission.
          const mapped = toDomainError(error, { entity: "repository", now: this.now });
          return mapped.kind === "forbidden" ? "missing" : "unverified";
        }
        if (status === 404) return onNotFound;
        if (status === 409) return onConflict;
        return "unverified";
      }
    };

    const ref = body.default_branch;
    const [pullsRead, contentsRead, checksRead, statusesRead] = [
      await probe("GET /repos/{owner}/{repo}/pulls", { state: "all" }, "missing", "unverified"),
      await probe("GET /repos/{owner}/{repo}/commits", {}, "missing", "granted"),
      await probe(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        { ref },
        "unverified",
        "unverified",
      ),
      await probe(
        "GET /repos/{owner}/{repo}/commits/{ref}/status",
        { ref },
        "unverified",
        "unverified",
      ),
    ];

    const push = body.permissions?.push;
    let contentsWrite: PermissionStatus;
    let pullsWrite: PermissionStatus;
    if (info.tokenKind === "classic") {
      const scopes = info.scopes ?? [];
      const scoped = scopes.includes("repo") || (!body.private && scopes.includes("public_repo"));
      const write: PermissionStatus = !scoped
        ? "missing"
        : push === true
          ? "granted"
          : push === false
            ? "missing"
            : "unverified";
      contentsWrite = write;
      pullsWrite = write;
    } else {
      const mergeSettingsVisible =
        body.allow_merge_commit !== undefined ||
        body.allow_squash_merge !== undefined ||
        body.allow_rebase_merge !== undefined;
      contentsWrite =
        push === false
          ? "missing"
          : mergeSettingsVisible
            ? "granted"
            : contentsRead === "granted"
              ? "missing"
              : "unverified";
      pullsWrite = "unverified";
    }

    const permissions: RepoPermissions = {
      pullRequests: { read: pullsRead, write: pullsWrite },
      contents: { read: contentsRead, write: contentsWrite },
      checks: { read: checksRead },
      statuses: { read: statusesRead },
    };
    return ok({ owner, repo, canonical: `${owner}/${repo}`, permissions });
  }
}
