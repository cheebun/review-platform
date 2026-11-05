import type { RepoPermissions } from "../../domain/settings/permissions";
import { repoKey } from "../../domain/settings/repo-entry";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type {
  GitHubVerifier,
  RepoCheckResult,
  TokenInfo,
  VerifiedToken,
} from "../../ports/github-verifier";

export const FULL_ACCESS: RepoPermissions = {
  pullRequests: { read: "granted", write: "granted" },
  contents: { read: "granted", write: "granted" },
  checks: { read: "granted" },
  statuses: { read: "granted" },
};

/**
 * Port-level fake. Unknown tokens are rejected (`forbidden`, like a 401); unknown repos are
 * `not_found` (like GitHub's 404 for a repo the token cannot see). Records every call.
 */
export class FakeGitHubVerifier implements GitHubVerifier {
  private readonly tokens = new Map<string, Result<VerifiedToken, DomainError>>();
  private readonly repos = new Map<string, Result<RepoCheckResult, DomainError>>();
  readonly calls: { method: "verifyToken" | "checkRepo"; token: string; repo?: string }[] = [];

  acceptToken(token: string, user: Partial<VerifiedToken> = {}): this {
    this.tokens.set(
      token,
      ok({
        login: "octocat",
        avatarUrl: "https://avatars.example.test/u/1",
        tokenKind: "fine_grained",
        scopes: null,
        ...user,
      }),
    );
    return this;
  }

  failToken(token: string, error: DomainError): this {
    this.tokens.set(token, err(error));
    return this;
  }

  /** What `checkRepo(token, canonical)` returns. `canonical` is GitHub's spelling. */
  grantRepo(token: string, canonical: string, permissions: RepoPermissions = FULL_ACCESS): this {
    const [owner, repo] = canonical.split("/");
    this.repos.set(`${token}\n${repoKey(canonical)}`, ok({ owner, repo, canonical, permissions }));
    return this;
  }

  failRepo(token: string, canonical: string, error: DomainError): this {
    this.repos.set(`${token}\n${repoKey(canonical)}`, err(error));
    return this;
  }

  async verifyToken(token: string): Promise<Result<VerifiedToken, DomainError>> {
    this.calls.push({ method: "verifyToken", token });
    return (
      structuredClone(this.tokens.get(token)) ??
      err({ kind: "forbidden", reason: "GitHub rejected the credentials or permissions" })
    );
  }

  async checkRepo(
    token: string,
    target: { owner: string; repo: string },
    _info: TokenInfo,
  ): Promise<Result<RepoCheckResult, DomainError>> {
    const name = `${target.owner}/${target.repo}`;
    this.calls.push({ method: "checkRepo", token, repo: name });
    return (
      structuredClone(this.repos.get(`${token}\n${repoKey(name)}`)) ??
      err({ kind: "not_found", entity: "repository" })
    );
  }
}
