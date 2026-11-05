import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, inject } from "vitest";
import { createPgDb, migrate, redactUrl, type Db, type PgDb } from "../../adapters/db/client";
import { truncateAll } from "../../adapters/db/truncate";
import { MIN_POOL } from "./pg-budget";
import { testPgUrl } from "./urls";

export { MIN_POOL };

/** `test_<runId>_<8 hex of the test file path>`: matches `RUN_SCHEMA` in stale-schemas.ts. */
export function fileSchemaName(runId: string, file: string): string {
  const hash = createHash("sha1").update(file).digest("hex").slice(0, 8);
  return `test_${runId}_${hash}`;
}

/**
 * Integration fixture for a `*.int.test.ts` file. Creates schema `test_<runId>_<hash>` on the
 * remote PostgreSQL (comment = ISO creation time, for stale cleanup), migrates into it, truncates
 * before every test and drops the schema afterwards. The pool has at least MIN_POOL connections
 * so parallel claims genuinely reach the server concurrently. Call at module top level.
 */
export function pgSchemaFixture(testFile: string): { db(): Db; pool(): PgDb; schema: string } {
  const runId = inject("runId");
  if (!/^[a-z0-9]+$/.test(runId)) throw new Error("unexpected runId shape");
  const schema = fileSchemaName(runId, testFile);
  let pg: PgDb | undefined;

  beforeAll(async () => {
    const url = testPgUrl();
    pg = createPgDb({ url, searchPath: schema, max: MIN_POOL });
    expect(pg.poolSize).toBeGreaterThanOrEqual(MIN_POOL);
    try {
      await pg.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
      // schema is test_[a-z0-9]+_[0-9a-f]{8}, so the identifier is safe to inline in COMMENT.
      await pg.db.execute(
        sql.raw(`COMMENT ON SCHEMA "${schema}" IS '${new Date().toISOString()}'`),
      );
      await migrate(pg.db, { migrationsSchema: schema });
    } catch (error) {
      throw new Error(redactUrl(error instanceof Error ? error.message : String(error), url));
    }
  }, 120_000);

  afterAll(async () => {
    if (!pg) return;
    try {
      await pg.db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
    } finally {
      await pg.close();
    }
  }, 60_000);

  beforeEach(async () => {
    await truncateAll(pg!.db);
  });

  return { db: () => pg!.db, pool: () => pg!, schema };
}
