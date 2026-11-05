import { eq } from "drizzle-orm";
import { err, ok, type Result } from "../../domain/shared/result";
import {
  ALREADY_INITIALIZED,
  assertLoginTokenHash,
  LOGIN_TOKEN_NOT_FOUND,
  type LoginTokenStore,
} from "../../ports/login-token-store";
import type { Clock } from "../../ports/system";
import type { Db } from "./client";
import { LOGIN_TOKEN_ID, loginToken } from "./pg-login-token-store-schema";

/**
 * Rotates the hash with `db`, which may be a transaction: a caller that must also revoke every
 * session runs both in one `db.transaction`, so they commit or roll back together. The UPDATE's
 * row lock serialises concurrent rotations until commit.
 */
export async function rotateLoginTokenHash(
  db: Pick<Db, "update">,
  hash: string,
  at: Date,
): Promise<Result<void>> {
  assertLoginTokenHash(hash);
  const rows = await db
    .update(loginToken)
    .set({ tokenHash: hash, rotatedAt: at })
    .where(eq(loginToken.id, LOGIN_TOKEN_ID))
    .returning({ id: loginToken.id });
  return rows.length > 0 ? ok(undefined) : err(LOGIN_TOKEN_NOT_FOUND);
}

/** `login_token`: the single row holding the login token's PBKDF2 hash. */
export class PgLoginTokenStore implements LoginTokenStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async isInitialized(): Promise<boolean> {
    return (await this.getHash()) !== null;
  }

  async getHash(): Promise<string | null> {
    const [row] = await this.db
      .select({ tokenHash: loginToken.tokenHash })
      .from(loginToken)
      .where(eq(loginToken.id, LOGIN_TOKEN_ID));
    return row?.tokenHash ?? null;
  }

  /**
   * `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`: the primary key makes this the single
   * writer. A concurrent insert waits on the first one's commit and then returns no row.
   */
  async initialize(hash: string): Promise<Result<void>> {
    assertLoginTokenHash(hash);
    const rows = await this.db
      .insert(loginToken)
      .values({ id: LOGIN_TOKEN_ID, tokenHash: hash, createdAt: this.clock.now(), rotatedAt: null })
      .onConflictDoNothing({ target: loginToken.id })
      .returning({ id: loginToken.id });
    return rows.length > 0 ? ok(undefined) : err(ALREADY_INITIALIZED);
  }

  async rotate(hash: string): Promise<Result<void>> {
    return rotateLoginTokenHash(this.db, hash, this.clock.now());
  }

}
