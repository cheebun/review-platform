import type { RepoAccess, RepoPermissions } from "../domain/settings/permissions";
import type { RepoEntry } from "../domain/settings/repo-entry";
import type { DomainError, Result } from "../domain/shared/result";
import type { NewReviewEvent } from "./review-event-repo";

/** One row of `github_repo`. */
export type StoredRepo = RepoEntry & {
  access: RepoAccess;
  permissions: RepoPermissions | null;
  checkedAt: Date | null;
  addedAt: Date;
  addedBy: string;
};

export type RepoCheck = {
  access: RepoAccess;
  permissions: RepoPermissions | null;
  checkedAt: Date;
};

/**
 * The repo list (FR-GITHUB-07): allowlist, Slack trigger set and `/review` picker. Names are
 * unique case-insensitively. `addRepo` enforces uniqueness and the size limit atomically, so two
 * concurrent adds can never exceed `max` or store a duplicate.
 *
 * Adding and removing record their history event in the same transaction (architecture.md §1
 * principle 4): `event` builds it from the stored or removed row, and if the event cannot be
 * stored the change is rolled back and the call rejects. `event` must be pure.
 */
export interface SettingsRepo {
  /** Ordered by `addedAt`, then canonical name. */
  listRepos(): Promise<StoredRepo[]>;
  /** `validation` (field `repo`) for a duplicate or a full list; then no event is recorded. */
  addRepo(
    repo: StoredRepo,
    options: { max: number; event: (stored: StoredRepo) => NewReviewEvent },
  ): Promise<Result<StoredRepo, DomainError>>;
  /** Records a re-check. Case-insensitive match; false when the repo is not listed. */
  updateRepoCheck(canonical: string, check: RepoCheck): Promise<boolean>;
  /** Case-insensitive. Returns the removed row, or null (and records no event). */
  removeRepo(
    canonical: string,
    event: (removed: StoredRepo) => NewReviewEvent,
  ): Promise<StoredRepo | null>;
}
