import type { TokenKind } from "../domain/settings/github-credential";
import type { RepoPermissions } from "../domain/settings/permissions";
import type { DomainError, Result } from "../domain/shared/result";

export type VerifiedToken = {
  login: string;
  avatarUrl: string;
  tokenKind: TokenKind;
  /** Classic scopes from `X-OAuth-Scopes`; null when GitHub sent no scope header. */
  scopes: string[] | null;
};

export type TokenInfo = Pick<VerifiedToken, "tokenKind" | "scopes">;

export type RepoCheckResult = {
  owner: string;
  repo: string;
  /** `owner/repo` exactly as GitHub returns it (`full_name`). */
  canonical: string;
  permissions: RepoPermissions;
};

/**
 * Read-only checks of a GitHub token (FR-GITHUB-02, -07). The token is passed per call and is
 * held only for that call. No method ever issues a write request.
 *
 * Errors: `forbidden` (401/403 on the token or repo), `not_found` (404 repo), `rate_limited`,
 * `upstream` (5xx, network, timeout).
 */
export interface GitHubVerifier {
  verifyToken(token: string): Promise<Result<VerifiedToken, DomainError>>;
  checkRepo(
    token: string,
    repo: { owner: string; repo: string },
    info: TokenInfo,
  ): Promise<Result<RepoCheckResult, DomainError>>;
}
