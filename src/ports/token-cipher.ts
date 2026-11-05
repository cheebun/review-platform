import type { Result } from "../domain/shared/result";

/** An encrypted GitHub token as stored in `github_credential`. Binary fields are base64. */
export type EncryptedToken = {
  ciphertext: string;
  iv: string;
  authTag: string;
  /** Which key derivation produced the key (`agent-ops:github-token:v<keyVersion>`). */
  keyVersion: number;
};

/**
 * Symmetric encryption of the stored GitHub token (FR-GITHUB-03). `decrypt` never throws: any
 * failure (rotated secret, tampered data, unknown key version) is `needs_reset`.
 */
export interface TokenCipher {
  encrypt(plaintext: string): EncryptedToken;
  decrypt(encrypted: EncryptedToken): Result<string, "needs_reset">;
}
