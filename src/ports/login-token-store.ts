import type { DomainError, Result } from "../domain/shared/result";

/** Prefix of every value the store accepts (`adapters/crypto/login-token-hash.ts`). */
export const LOGIN_TOKEN_HASH_PREFIX = "pbkdf2-sha256$";

/** Guards against storing plaintext by mistake: anything else is a programming error. */
export function assertLoginTokenHash(hash: string): void {
  if (typeof hash !== "string" || !hash.startsWith(LOGIN_TOKEN_HASH_PREFIX)) {
    throw new Error("login token store: value is not an encoded token hash");
  }
}

export const ALREADY_INITIALIZED: DomainError = {
  kind: "conflict",
  reason: "already initialized",
};
export const LOGIN_TOKEN_NOT_FOUND: DomainError = { kind: "not_found", entity: "login_token" };

/**
 * The single login token's hash, one row at most. Holds the encoded PBKDF2 hash only, never the
 * token; hashing is the caller's job. A value that is not an encoded hash rejects (throws).
 */
export interface LoginTokenStore {
  isInitialized(): Promise<boolean>;
  getHash(): Promise<string | null>;
  /**
   * First-run setup. Single writer: of any number of concurrent calls exactly one succeeds; every
   * other call, and any later one, is `conflict "already initialized"` and changes nothing.
   */
  initialize(hash: string): Promise<Result<void>>;
  /**
   * Replaces the hash and stamps `rotated_at`. `not_found login_token` before `initialize`.
   * Concurrent rotations are serialised by the row; the last one wins.
   */
  rotate(hash: string): Promise<Result<void>>;
}
