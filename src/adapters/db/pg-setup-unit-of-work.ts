import { asc } from "drizzle-orm";
import { err, type DomainError, type Result } from "../../domain/shared/result";
import type { SecretCiphers } from "../../ports/settings-store";
import type { SetupTx, SetupUnitOfWork } from "../../ports/setup-unit-of-work";
import type { Clock, IdGenerator } from "../../ports/system";
import { OWNER_USER_EMAIL } from "../auth/auth";
import type { Db } from "./client";
import { PgCredentialStore } from "./pg-credential-store";
import { PgLoginTokenStore } from "./pg-login-token-store";
import { PgSettingsRepo } from "./pg-settings-repo";
import { PgSettingsStore } from "./pg-settings-store";
import { user } from "./schema";

class Rollback {
  constructor(readonly error: DomainError) {}
}

type TxDb = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Postgres `SetupUnitOfWork`: one `db.transaction` per `run`. The stores are built on the
 * transaction, so their own `transaction` calls become savepoints inside it and everything
 * commits or rolls back together. An `err` result rolls back by throwing a private sentinel out
 * of the callback; any other throw rolls back and is re-thrown.
 */
export class PgSetupUnitOfWork implements SetupUnitOfWork {
  constructor(
    private readonly db: Db,
    private readonly ciphers: SecretCiphers,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async run<T>(fn: (tx: SetupTx) => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await this.db.transaction(async (raw) => {
        const out = await fn(this.bind(raw));
        if (!out.ok) throw new Rollback(out.error);
        return out;
      });
    } catch (error) {
      if (error instanceof Rollback) return err(error.error);
      throw error;
    }
  }

  private bind(raw: TxDb): SetupTx {
    const tx = raw as unknown as Db;
    return {
      initializeLoginToken: (hash) => new PgLoginTokenStore(tx, this.clock).initialize(hash),
      ensureOwnerUser: () => this.ensureOwnerUser(tx),
      settingsStore: new PgSettingsStore(tx, this.ciphers),
      githubCredentials: new PgCredentialStore(tx),
      githubRepos: new PgSettingsRepo(tx),
    };
  }

  /**
   * The oldest user (an instance upgraded from email login keeps its user), else a new internal
   * owner, as better-auth's sign-in would create it. Runs after the login token insert, which
   * already serialises concurrent setups.
   */
  private async ensureOwnerUser(tx: Db): Promise<string> {
    const oldest = async () =>
      (await tx.select({ id: user.id }).from(user).orderBy(asc(user.createdAt)).limit(1))[0];
    const existing = await oldest();
    if (existing) return existing.id;
    const now = this.clock.now();
    await tx
      .insert(user)
      .values({
        id: this.ids.uuid(),
        name: "Owner",
        email: OWNER_USER_EMAIL,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: user.email });
    const created = await oldest();
    if (!created) throw new Error("setup: owner user not created");
    return created.id;
  }
}
