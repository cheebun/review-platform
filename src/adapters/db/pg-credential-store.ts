import { eq, sql } from "drizzle-orm";
import type { CredentialMeta } from "../../domain/settings/github-credential";
import type {
  CredentialStore,
  CredentialWrite,
  StoredCredential,
} from "../../ports/credential-store";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import type { Db } from "./client";
import { insertReviewEvent } from "./pg-review-event-repo";
import { GITHUB_CREDENTIAL_ID, githubCredential } from "./schema";

type Row = typeof githubCredential.$inferSelect;

const toMeta = (row: Row): CredentialMeta => ({
  login: row.login,
  avatarUrl: row.avatarUrl,
  last4: row.last4,
  savedAt: row.savedAt,
  savedByUserId: row.savedByUserId,
  tokenKind: row.permissions.tokenKind,
  scopes: row.permissions.scopes ? [...row.permissions.scopes] : null,
  version: row.version,
});

/** `github_credential` (one row). Ciphertext only: this adapter never sees the plaintext. */
export class PgCredentialStore implements CredentialStore {
  constructor(private readonly db: Db) {}

  async get(): Promise<StoredCredential | null> {
    const [row] = await this.db
      .select()
      .from(githubCredential)
      .where(eq(githubCredential.id, GITHUB_CREDENTIAL_ID));
    if (!row) return null;
    return {
      encrypted: {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      },
      meta: toMeta(row),
    };
  }

  /**
   * Upsert, then the event, in one transaction. The upsert's row lock serialises concurrent saves
   * until commit, and the version tells an insert (1, also after a removal) from a replacement.
   */
  async save(
    write: CredentialWrite,
    event: (outcome: { replaced: boolean }) => NewReviewEvent,
  ): Promise<{ meta: CredentialMeta; replaced: boolean }> {
    const values = {
      ciphertext: write.encrypted.ciphertext,
      iv: write.encrypted.iv,
      authTag: write.encrypted.authTag,
      keyVersion: write.encrypted.keyVersion,
      login: write.login,
      avatarUrl: write.avatarUrl,
      last4: write.last4,
      permissions: { tokenKind: write.tokenKind, scopes: write.scopes },
      savedAt: write.savedAt,
      savedByUserId: write.savedByUserId,
    };
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(githubCredential)
        .values({ id: GITHUB_CREDENTIAL_ID, ...values, version: 1 })
        .onConflictDoUpdate({
          target: githubCredential.id,
          set: { ...values, version: sql`${githubCredential.version} + 1` },
        })
        .returning();
      const replaced = row.version > 1;
      await insertReviewEvent(tx, event({ replaced }));
      return { meta: toMeta(row), replaced };
    });
  }

  async remove(event: (removed: CredentialMeta) => NewReviewEvent): Promise<CredentialMeta | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(githubCredential)
        .where(eq(githubCredential.id, GITHUB_CREDENTIAL_ID))
        .returning();
      if (!row) return null;
      const meta = toMeta(row);
      await insertReviewEvent(tx, event(meta));
      return meta;
    });
  }
}
