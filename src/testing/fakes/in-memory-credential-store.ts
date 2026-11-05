import type { CredentialMeta } from "../../domain/settings/github-credential";
import type {
  CredentialStore,
  CredentialWrite,
  StoredCredential,
} from "../../ports/credential-store";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import { InMemoryReviewEventRepo } from "./in-memory-review-event-repo";

/**
 * One-row credential store. Each write and its event happen with no await in between, so the
 * call is atomic (single-threaded JS), as the PG transaction is; a failed event changes nothing.
 * Pass the `InMemoryReviewEventRepo` the rest of the test reads, as PG shares one database.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private row: StoredCredential | null = null;

  constructor(private readonly events: InMemoryReviewEventRepo = new InMemoryReviewEventRepo()) {}

  async get(): Promise<StoredCredential | null> {
    return this.row ? structuredClone(this.row) : null;
  }

  async save(
    write: CredentialWrite,
    event: (outcome: { replaced: boolean }) => NewReviewEvent,
  ): Promise<{ meta: CredentialMeta; replaced: boolean }> {
    const replaced = this.row !== null;
    const meta: CredentialMeta = {
      login: write.login,
      avatarUrl: write.avatarUrl,
      last4: write.last4,
      savedAt: new Date(write.savedAt),
      savedByUserId: write.savedByUserId,
      tokenKind: write.tokenKind,
      scopes: write.scopes ? [...write.scopes] : null,
      version: (this.row?.meta.version ?? 0) + 1,
    };
    this.events.appendNow(event({ replaced }));
    this.row = { encrypted: { ...write.encrypted }, meta };
    return { meta: structuredClone(meta), replaced };
  }

  async remove(event: (removed: CredentialMeta) => NewReviewEvent): Promise<CredentialMeta | null> {
    if (!this.row) return null;
    const removed = structuredClone(this.row.meta);
    this.events.appendNow(event(structuredClone(removed)));
    this.row = null;
    return removed;
  }

  /** Test helper: what the "database" holds, for plaintext substring checks. */
  dump(): string {
    return JSON.stringify(this.row);
  }
}
