import type { Result } from "../domain/shared/result";
import type { CredentialStore } from "./credential-store";
import type { SettingsRepo } from "./settings-repo";
import type { SettingsStore } from "./settings-store";

/** The writes of first-run setup, all bound to one transaction. */
export interface SetupTx {
  /**
   * Inserts the login token hash (`ON CONFLICT DO NOTHING`). `conflict "already initialized"`
   * when a row exists; a concurrent setup waits on the first one's commit, then gets the same.
   */
  initializeLoginToken(hash: string): Promise<Result<void>>;
  /** The owner user's id: the oldest user, else a new internal one. */
  ensureOwnerUser(): Promise<string>;
  settingsStore: SettingsStore;
  githubCredentials: CredentialStore;
  githubRepos: SettingsRepo;
}

/**
 * First-run setup's single transaction (FR-AUTH-01). An `err` result or a throw rolls back every
 * write made through the `SetupTx`, the login token included.
 */
export interface SetupUnitOfWork {
  run<T>(fn: (tx: SetupTx) => Promise<Result<T>>): Promise<Result<T>>;
}
