import { err, ok, type DomainError, type Result } from "../shared/result";

/**
 * The single user-chosen login token. Pure: no I/O, no crypto, safe on the client. Hashing lives
 * in `adapters/crypto/login-token-hash.ts` (server-only).
 */

export const MIN_LOGIN_TOKEN_LENGTH = 6;

const invalid = (message: string): { ok: false; error: DomainError } =>
  err({ kind: "validation", field: "token", message });

/**
 * Checks a login token as typed. Surrounding whitespace is rejected, never trimmed: the stored
 * hash must match exactly what the user will type at login. Inner spaces are allowed
 * (passphrases). No maximum length. Length is in UTF-16 code units.
 */
export function validateLoginTokenInput(input: unknown): Result<string, DomainError> {
  if (typeof input !== "string") return invalid("Token must be a string.");
  if (input.trim().length !== input.length) {
    return invalid("Token must not start or end with whitespace.");
  }
  if (input.length < MIN_LOGIN_TOKEN_LENGTH) {
    return invalid(`Token must be at least ${MIN_LOGIN_TOKEN_LENGTH} characters.`);
  }
  return ok(input);
}
