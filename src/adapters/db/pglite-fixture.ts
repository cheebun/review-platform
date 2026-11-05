import { afterAll, beforeAll, beforeEach } from "vitest";
import { createPgliteDb, migrate, type Db, type PgliteHandle } from "./client";
import { truncateAll } from "./truncate";

/**
 * db-fast fixture: one PGlite instance per test file, migrated once, tables truncated before
 * each test. Call at module top level of a `*.db.test.ts` file.
 */
export function pgliteFixture(): { db(): Db } {
  let handle: PgliteHandle | undefined;
  beforeAll(async () => {
    handle = await createPgliteDb();
    await migrate(handle.db);
  }, 60_000);
  afterAll(async () => {
    await handle?.close();
  });
  beforeEach(async () => {
    await truncateAll(handle!.db);
  });
  return { db: () => handle!.db };
}
