import { err, ok, type DomainError, type Result } from "../shared/result";

/**
 * Real GitHub tokens are 40+ characters. The lower bound (assumed) keeps `last4` from revealing a
 * meaningful share of a short value; the upper bound is FR-GITHUB-02's 255.
 */
export const MIN_TOKEN_LENGTH = 20;
export const MAX_TOKEN_LENGTH = 255;

/** `classic`: GitHub sent `X-OAuth-Scopes`; otherwise fine-grained (no scope header). */
export type TokenKind = "classic" | "fine_grained";

/** Everything stored next to the ciphertext. Never contains the token. */
export type CredentialMeta = {
  login: string;
  avatarUrl: string;
  last4: string;
  savedAt: Date;
  savedByUserId: string;
  tokenKind: TokenKind;
  /** Classic token scopes from `X-OAuth-Scopes`; null for fine-grained tokens. */
  scopes: string[] | null;
  /** Optimistic-concurrency version of the credential row. */
  version: number;
};

/** What the client may see about the token (FR-GITHUB-03). */
export type TokenDisplay = {
  login: string;
  avatarUrl: string;
  last4: string;
  /** ISO 8601. */
  savedAt: string;
  tokenKind: TokenKind;
  scopes: string[] | null;
};

export type GithubAvailability =
  | { state: "not_configured" }
  | { state: "needs_reset"; login: string }
  | { state: "ready"; login: string };

/** Visible ASCII only: rejects whitespace and control characters anywhere inside. */
const TOKEN_RE = /^[\x21-\x7e]+$/;

const invalid = (message: string): { ok: false; error: DomainError } =>
  err({ kind: "validation", field: "token", message });

/** FR-GITHUB-02 step 1. Surrounding whitespace (a pasted newline) is trimmed first. */
export function parseTokenInput(input: unknown): Result<string, DomainError> {
  if (typeof input !== "string") return invalid("Token must be a string.");
  const value = input.trim();
  if (value.length === 0) return invalid("Token is required.");
  if (value.length < MIN_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH) {
    return invalid(
      `Token must be ${MIN_TOKEN_LENGTH} to ${MAX_TOKEN_LENGTH} characters without spaces.`,
    );
  }
  if (!TOKEN_RE.test(value)) return invalid("Token must not contain spaces.");
  return ok(value);
}

/** Last four characters, shown on the connection card. */
export const tokenLast4 = (token: string): string => token.slice(-4);

/** Explicit pick: anything else on the input (ciphertext, ids) never reaches the client. */
export function toTokenDisplay(meta: CredentialMeta): TokenDisplay {
  return {
    login: meta.login,
    avatarUrl: meta.avatarUrl,
    last4: meta.last4,
    savedAt: meta.savedAt.toISOString(),
    tokenKind: meta.tokenKind,
    scopes: meta.scopes ? [...meta.scopes] : null,
  };
}

/** FR-GITHUB-05: no row → 未配置; a row that cannot be decrypted → 需要重新设置. */
export function githubAvailability(
  row: { meta: CredentialMeta; decrypts: boolean } | null,
): GithubAvailability {
  if (!row) return { state: "not_configured" };
  return row.decrypts
    ? { state: "ready", login: row.meta.login }
    : { state: "needs_reset", login: row.meta.login };
}
