import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgliteDb, MIGRATIONS_FOLDER, type PgliteHandle } from "../adapters/db/client";
import type { LogFields, Logger } from "../ports/system";
import { MigrationFailedError, migrateOnBoot, type LockSession } from "./migrate-on-boot";

type Entry = { level: string; msg: string; fields: LogFields };
function recordingLogger(): Logger & { entries: Entry[] } {
  const entries: Entry[] = [];
  const make = (bound: LogFields): Logger => ({
    debug: (msg, fields) => entries.push({ level: "debug", msg, fields: { ...bound, ...fields } }),
    info: (msg, fields) => entries.push({ level: "info", msg, fields: { ...bound, ...fields } }),
    warn: (msg, fields) => entries.push({ level: "warn", msg, fields: { ...bound, ...fields } }),
    error: (msg, fields) => entries.push({ level: "error", msg, fields: { ...bound, ...fields } }),
    child: (fields) => make({ ...bound, ...fields }),
  });
  return Object.assign(make({}), { entries });
}

/** PGlite has one session, so the "dedicated" lock session shares it; close is a spy. */
function pgliteLock(client: PGlite): LockSession & { close: ReturnType<typeof vi.fn> } {
  return {
    tryLock: async (key) =>
      (
        await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1::bigint) as ok", [
          key.toString(),
        ])
      ).rows[0]!.ok,
    unlock: async (key) => {
      await client.query("select pg_advisory_unlock($1::bigint)", [key.toString()]);
    },
    close: vi.fn(async () => {}),
  };
}

const MIGRATION_NAMES = readdirSync(MIGRATIONS_FOLDER)
  .filter((n) => /^\d{14}_/.test(n))
  .toSorted();

let handle: PgliteHandle;
let fixtures: string;
beforeAll(async () => {
  handle = await createPgliteDb();
  fixtures = mkdtempSync(join(tmpdir(), "migrate-on-boot-"));
}, 60_000);
afterAll(async () => {
  await handle.close();
  rmSync(fixtures, { recursive: true, force: true });
});

const tables = async (schema: string): Promise<string[]> =>
  (
    await handle.client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = $1 order by 1",
      [schema],
    )
  ).rows.map((r) => r.table_name);

const advisoryLocks = async (): Promise<number> =>
  (
    await handle.client.query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory'",
    )
  ).rows[0]!.n;

/** The real migrations plus one whose SQL is invalid. */
function badMigrationsFolder(): string {
  const dir = join(fixtures, "bad");
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  mkdirSync(join(dir, "29991231235959_broken"));
  writeFileSync(
    join(dir, "29991231235959_broken", "migration.sql"),
    "CREATE TABLE broken_ok (id int);\n--> statement-breakpoint\nTHIS IS NOT SQL;\n",
  );
  return dir;
}

describe("migrateOnBoot (PGlite)", () => {
  it("creates every table in a fresh schema and logs the applied migration names", async () => {
    const logger = recordingLogger();
    const lock = pgliteLock(handle.client);
    const result = await migrateOnBoot({ db: handle.db, lock, schema: "fresh", logger });
    expect(result.applied).toEqual(MIGRATION_NAMES);
    const created = await tables("fresh");
    for (const t of ["app_state", "review_job", "setting_value", "__drizzle_migrations"]) {
      expect(created).toContain(t);
    }
    const info = logger.entries.find((e) => e.msg === "migrations applied");
    expect(info?.fields).toMatchObject({ schema: "fresh", applied: MIGRATION_NAMES });
    expect(typeof info?.fields.durationMs).toBe("number");
    expect(lock.close).toHaveBeenCalledOnce();
    expect(await advisoryLocks()).toBe(0);
  }, 60_000);

  it("logs up to date on a second run", async () => {
    const logger = recordingLogger();
    const result = await migrateOnBoot({
      db: handle.db,
      lock: pgliteLock(handle.client),
      schema: "fresh",
      logger,
    });
    expect(result.applied).toEqual([]);
    expect(logger.entries.some((e) => e.msg === "migrations up to date")).toBe(true);
  }, 60_000);

  it("rejects a failing migration, logs the Postgres code, releases the lock; the next call can lock", async () => {
    const logger = recordingLogger();
    const lock = pgliteLock(handle.client);
    const run = migrateOnBoot({
      db: handle.db,
      lock,
      schema: "broken",
      logger,
      migrationsFolder: badMigrationsFolder(),
    });
    await expect(run).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(run).rejects.toThrow(/42601/);
    const failure = logger.entries.find((e) => e.msg === "migrations failed");
    expect(failure?.fields).toMatchObject({ schema: "broken", causeCode: "42601" });
    expect(JSON.stringify(failure?.fields)).not.toContain("NOT SQL");
    expect(lock.close).toHaveBeenCalledOnce();
    expect(await advisoryLocks()).toBe(0);
    // One transaction: nothing of the failed run is left behind.
    expect(await tables("broken")).not.toContain("broken_ok");

    const next = await migrateOnBoot({
      db: handle.db,
      lock: pgliteLock(handle.client),
      schema: "broken",
      logger: recordingLogger(),
    });
    expect(next.applied).toEqual(MIGRATION_NAMES);
  }, 60_000);

  it("without a schema puts the tables in public and the journal in drizzle", async () => {
    const own = await createPgliteDb();
    try {
      const result = await migrateOnBoot({
        db: own.db,
        lock: pgliteLock(own.client),
        logger: recordingLogger(),
      });
      expect(result.applied).toEqual(MIGRATION_NAMES);
      const pub = await own.client.query<{ n: number }>(
        "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'app_state'",
      );
      expect(pub.rows[0]!.n).toBe(1);
      const journal = await own.client.query<{ n: number }>(
        "select count(*)::int as n from drizzle.__drizzle_migrations",
      );
      expect(journal.rows[0]!.n).toBe(MIGRATION_NAMES.length);
    } finally {
      await own.close();
    }
  }, 60_000);
});
