import type { CredentialMeta, TokenKind } from "../domain/settings/github-credential";
import type { NewReviewEvent } from "./review-event-repo";
import type { EncryptedToken } from "./token-cipher";

/** The single `github_credential` row: ciphertext plus display metadata. */
export type StoredCredential = { encrypted: EncryptedToken; meta: CredentialMeta };

export type CredentialWrite = {
  encrypted: EncryptedToken;
  login: string;
  avatarUrl: string;
  last4: string;
  tokenKind: TokenKind;
  scopes: string[] | null;
  savedAt: Date;
  savedByUserId: string;
};

/**
 * Storage of the one GitHub credential (FR-GITHUB-03). Holds ciphertext only; encryption is the
 * caller's job (`TokenCipher`). Concurrent saves are serialised by the row and the last one wins
 * (FR-GITHUB-02 AC2).
 *
 * Every write records its history event in the same transaction (architecture.md §1 principle
 * 4): `event` builds it from the outcome, and if the event cannot be stored the write is rolled
 * back and the call rejects. `event` must be pure; it runs inside the transaction.
 */
export interface CredentialStore {
  get(): Promise<StoredCredential | null>;
  /** Inserts or replaces the row. `replaced` is true when a row existed before this write. */
  save(
    write: CredentialWrite,
    event: (outcome: { replaced: boolean }) => NewReviewEvent,
  ): Promise<{ meta: CredentialMeta; replaced: boolean }>;
  /**
   * Deletes the row. Returns what was removed, or null when there was nothing; then no event is
   * recorded.
   */
  remove(event: (removed: CredentialMeta) => NewReviewEvent): Promise<CredentialMeta | null>;
}
