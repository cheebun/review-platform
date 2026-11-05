import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fakes/fake-clock";
import {
  HASH_A,
  HASH_B,
  loginTokenStoreContract,
} from "../../testing/contracts/login-token-store.contract";
import { loginToken } from "./pg-login-token-store-schema";
import { PgLoginTokenStore, rotateLoginTokenHash } from "./pg-login-token-store";
import { pgliteFixture } from "./pglite-fixture";

const fixture = pgliteFixture();

loginTokenStoreContract(async () => ({
  impl: new PgLoginTokenStore(fixture.db(), new FakeClock()),
  advance: async () => {},
  cleanup: async () => {},
}));

describe("PgLoginTokenStore (PG specifics)", () => {
  const T0 = new Date("2026-11-05T01:00:00.000Z");
  const T1 = new Date("2026-11-05T02:00:00.000Z");

  it("records created_at on initialize and rotated_at on rotate", async () => {
    const clock = new FakeClock(T0);
    const store = new PgLoginTokenStore(fixture.db(), clock);
    await store.initialize(HASH_A);
    let [row] = await fixture.db().select().from(loginToken);
    expect(row).toEqual({ id: 1, tokenHash: HASH_A, createdAt: T0, rotatedAt: null });

    clock.set(T1);
    await store.rotate(HASH_B);
    [row] = await fixture.db().select().from(loginToken);
    expect(row).toEqual({ id: 1, tokenHash: HASH_B, createdAt: T0, rotatedAt: T1 });
  });

  it("rotateLoginTokenHash commits or rolls back with the caller's transaction", async () => {
    const store = new PgLoginTokenStore(fixture.db(), new FakeClock(T0));
    await store.initialize(HASH_A);

    await expect(
      fixture.db().transaction(async (tx) => {
        expect(await rotateLoginTokenHash(tx, HASH_B, T1)).toEqual({ ok: true, value: undefined });
        throw new Error("later step failed");
      }),
    ).rejects.toThrow("later step failed");
    expect(await store.getHash()).toBe(HASH_A);

    await fixture.db().transaction(async (tx) => {
      expect(await rotateLoginTokenHash(tx, HASH_B, T1)).toEqual({ ok: true, value: undefined });
    });
    expect(await store.getHash()).toBe(HASH_B);
  });

  it("the table holds at most one row with id 1", async () => {
    await expect(
      fixture
        .db()
        .execute(
          sql`INSERT INTO login_token (id, token_hash, created_at) VALUES (2, ${HASH_A}, now())`,
        ),
    ).rejects.toThrow();
  });

  it("the table refuses a value that is not an encoded hash", async () => {
    await expect(
      fixture
        .db()
        .execute(
          sql`INSERT INTO login_token (id, token_hash, created_at) VALUES (1, 'plaintext', now())`,
        ),
    ).rejects.toThrow();
  });
});
