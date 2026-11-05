import { asc, sql } from "drizzle-orm";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import type { RepoCheck, SettingsRepo, StoredRepo } from "../../ports/settings-repo";
import type { Db } from "./client";
import { insertReviewEvent } from "./pg-review-event-repo";
import { githubRepo } from "./schema";

type Row = typeof githubRepo.$inferSelect;

const toRepo = (row: Row): StoredRepo => ({
  owner: row.owner,
  repo: row.repo,
  canonical: row.canonical,
  access: row.access,
  permissions: row.permissions ?? null,
  checkedAt: row.checkedAt ?? null,
  addedAt: row.addedAt,
  addedBy: row.addedBy,
});

const sameName = (canonical: string) => sql`lower(${githubRepo.canonical}) = lower(${canonical})`;

const invalid = (message: string) =>
  err<DomainError>({ kind: "validation", field: "repo", message });

/** `github_repo`. Names compare case-insensitively (`github_repo_canonical_lower_idx`). */
export class PgSettingsRepo implements SettingsRepo {
  constructor(private readonly db: Db) {}

  async listRepos(): Promise<StoredRepo[]> {
    const rows = await this.db
      .select()
      .from(githubRepo)
      .orderBy(asc(githubRepo.addedAt), asc(githubRepo.canonical));
    return rows.map(toRepo);
  }

  /**
   * The duplicate and size checks and the insert run under a table lock that conflicts with
   * itself, so concurrent adds are serialised and `max` holds. Readers are not blocked. The event
   * is inserted in the same transaction.
   */
  async addRepo(
    repo: StoredRepo,
    options: { max: number; event: (stored: StoredRepo) => NewReviewEvent },
  ): Promise<Result<StoredRepo, DomainError>> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${githubRepo} IN SHARE ROW EXCLUSIVE MODE`);
      const [dup] = await tx
        .select({ canonical: githubRepo.canonical })
        .from(githubRepo)
        .where(sameName(repo.canonical));
      if (dup) return invalid("This repository is already in the list.");
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(githubRepo);
      if (n >= options.max) return invalid("The repository list is full.");
      const [row] = await tx
        .insert(githubRepo)
        .values({
          canonical: repo.canonical,
          owner: repo.owner,
          repo: repo.repo,
          access: repo.access,
          permissions: repo.permissions,
          checkedAt: repo.checkedAt,
          addedAt: repo.addedAt,
          addedBy: repo.addedBy,
        })
        .returning();
      const stored = toRepo(row);
      await insertReviewEvent(tx, options.event(stored));
      return ok(stored);
    });
  }

  async updateRepoCheck(canonical: string, check: RepoCheck): Promise<boolean> {
    const rows = await this.db
      .update(githubRepo)
      .set({ access: check.access, permissions: check.permissions, checkedAt: check.checkedAt })
      .where(sameName(canonical))
      .returning({ canonical: githubRepo.canonical });
    return rows.length > 0;
  }

  async removeRepo(
    canonical: string,
    event: (removed: StoredRepo) => NewReviewEvent,
  ): Promise<StoredRepo | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.delete(githubRepo).where(sameName(canonical)).returning();
      if (!row) return null;
      const removed = toRepo(row);
      await insertReviewEvent(tx, event(removed));
      return removed;
    });
  }
}
