/**
 * Hashes and checks the login token (`adapters/crypto/login-token-hash.ts`: PBKDF2-HMAC-SHA256).
 * A port so the use cases stay free of crypto and tests can use a fast fake.
 */
export interface LoginTokenHasher {
  /** An encoded salted hash of `token`. Validate the token first. */
  hash(token: string): Promise<string>;
  /** True only when `token` matches `encoded`, compared in constant time. Never throws. */
  verify(token: string, encoded: string): Promise<boolean>;
}
