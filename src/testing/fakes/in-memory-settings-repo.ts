import { repoKey } from "../../domain/settings/repo-entry";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import type { RepoCheck, SettingsRepo, StoredRepo } from "../../ports/settings-repo";
import { InMemoryReviewEventRepo } from "./in-memory-review-event-repo";

/**
 * Adds and removes write the row and its event with no await in between (atomic, like the PG
 * transaction); a failed event changes nothing. Share the test's `InMemoryReviewEventRepo`.
 */
export class InMemorySettingsRepo implements SettingsRepo {
  private readonly rows = new Map<string, StoredRepo>();

  constructor(private readonly events: InMemoryReviewEventRepo = new InMemoryReviewEventRepo()) {}

  async listRepos(): Promise<StoredRepo[]> {
    return [...this.rows.values()]
      .toSorted(
        (a, b) =>
          a.addedAt.getTime() - b.addedAt.getTime() || a.canonical.localeCompare(b.canonical),
      )
      .map((r) => structuredClone(r));
  }

  async addRepo(
    repo: StoredRepo,
    options: { max: number; event: (stored: StoredRepo) => NewReviewEvent },
  ): Promise<Result<StoredRepo, DomainError>> {
    const key = repoKey(repo.canonical);
    if (this.rows.has(key)) {
      return err({
        kind: "validation",
        field: "repo",
        message: "This repository is already in the list.",
      });
    }
    if (this.rows.size >= options.max) {
      return err({ kind: "validation", field: "repo", message: "The repository list is full." });
    }
    this.events.appendNow(options.event(structuredClone(repo)));
    this.rows.set(key, structuredClone(repo));
    return ok(structuredClone(repo));
  }

  async updateRepoCheck(canonical: string, check: RepoCheck): Promise<boolean> {
    const row = this.rows.get(repoKey(canonical));
    if (!row) return false;
    this.rows.set(repoKey(canonical), { ...row, ...structuredClone(check) });
    return true;
  }

  async removeRepo(
    canonical: string,
    event: (removed: StoredRepo) => NewReviewEvent,
  ): Promise<StoredRepo | null> {
    const key = repoKey(canonical);
    const row = this.rows.get(key);
    if (!row) return null;
    this.events.appendNow(event(structuredClone(row)));
    this.rows.delete(key);
    return structuredClone(row);
  }
}
