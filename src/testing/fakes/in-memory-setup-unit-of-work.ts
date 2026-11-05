import type { Result } from "../../domain/shared/result";
import type { CredentialStore } from "../../ports/credential-store";
import type { LoginTokenStore } from "../../ports/login-token-store";
import type { SettingsRepo } from "../../ports/settings-repo";
import type { SettingsStore } from "../../ports/settings-store";
import type { SetupTx, SetupUnitOfWork } from "../../ports/setup-unit-of-work";

/**
 * Setup's writes straight onto the in-memory stores. It does not roll back: atomicity is covered
 * by the PG integration test (pg-setup-unit-of-work.int.test.ts). `runs` counts transactions.
 */
export class InMemorySetupUnitOfWork implements SetupUnitOfWork {
  runs = 0;

  constructor(
    private readonly stores: {
      loginTokens: LoginTokenStore;
      settingsStore: SettingsStore;
      githubCredentials: CredentialStore;
      githubRepos: SettingsRepo;
    },
    private readonly ownerUserId = "owner",
  ) {}

  async run<T>(fn: (tx: SetupTx) => Promise<Result<T>>): Promise<Result<T>> {
    this.runs += 1;
    const { loginTokens, settingsStore, githubCredentials, githubRepos } = this.stores;
    return fn({
      initializeLoginToken: (hash) => loginTokens.initialize(hash),
      ensureOwnerUser: async () => this.ownerUserId,
      settingsStore,
      githubCredentials,
      githubRepos,
    });
  }
}
