import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../adapters/db/client";
import { fileSchemaName } from "../testing/integration/pg-fixture";
import { testPgUrl } from "../testing/integration/urls";
import type { LogFields, Logger } from "../ports/system";
import { MigrationFailedError, migrateDatabase, migrationLockKey } from "./migrate-on-boot";

/**
 * Lock behaviour against the remote test PostgreSQL. Each `migrateDatabase` call opens two
 * connections (lock session + migration session), so this file peaks at 5.
 */

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

const MIGRATION_NAMES = readdirSync(MIGRATIONS_FOLDER)
  .filter((n) => /^\d{14}_/.test(n))
  .toSorted();

const runId = inject("runId");
const schemaFor = (label: string) => fileSchemaName(runId, `${import.meta.url}#${label}`);
const created: string[] = [];

let admin: ReturnType<typeof postgres>;
let fixtures: string;

beforeAll(async () => {
  admin = postgres(testPgUrl(), {
    max: 1,
    ssl: "require",
    connect_timeout: 20,
    onnotice: () => {},
  });
  fixtures = mkdtempSync(join(tmpdir(), "migrate-on-boot-int-"));
});

afterAll(async () => {
  try {
    for (const schema of created) await admin.unsafe(`drop schema if exists "${schema}" cascade`);
  } finally {
    await admin.end({ timeout: 5 });
    rmSync(fixtures, { recursive: true, force: true });
  }
}, 60_000);

/** Pre-creates the schema with a timestamp comment so a crashed run is still cleaned up. */
async function newSchema(label: string): Promise<string> {
  const schema = schemaFor(label);
  created.push(schema);
  await admin.unsafe(`create schema "${schema}"`);
  await admin.unsafe(`comment on schema "${schema}" is '${new Date().toISOString()}'`);
  return schema;
}

function badMigrationsFolder(): string {
  const dir = join(fixtures, "bad");
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  mkdirSync(join(dir, "29991231235959_broken"));
  writeFileSync(join(dir, "29991231235959_broken", "migration.sql"), "THIS IS NOT SQL;\n");
  return dir;
}

describe("migrateDatabase (remote PostgreSQL)", () => {
  it("two concurrent calls on one schema apply each migration exactly once", async () => {
    const schema = await newSchema("concurrent");
    const results = await Promise.all([
      migrateDatabase({ url: testPgUrl(), schema, logger: recordingLogger() }),
      migrateDatabase({ url: testPgUrl(), schema, logger: recordingLogger() }),
    ]);
    const applied = results.map((r) => r.applied).toSorted((a, b) => b.length - a.length);
    expect(applied[0]).toEqual(MIGRATION_NAMES);
    expect(applied[1]).toEqual([]);
    const rows = await admin.unsafe<{ n: number; distinct_hashes: number }[]>(
      `select count(*)::int as n, count(distinct hash)::int as distinct_hashes from "${schema}".__drizzle_migrations`,
    );
    expect(rows[0]).toEqual({ n: MIGRATION_NAMES.length, distinct_hashes: MIGRATION_NAMES.length });
  }, 120_000);

  it("waits on a held lock up to the bound, while another schema migrates freely", async () => {
    const blocked = await newSchema("blocked");
    const free = await newSchema("free");
    const holder = postgres(testPgUrl(), { max: 1, ssl: "require", onnotice: () => {} });
    try {
      const [held] = await holder<{ ok: boolean }[]>`
        select pg_try_advisory_lock(${migrationLockKey(blocked).toString()}::bigint) as ok`;
      expect(held!.ok).toBe(true);

      const logger = recordingLogger();
      const started = Date.now();
      const [waited, other] = await Promise.allSettled([
        migrateDatabase({ url: testPgUrl(), schema: blocked, logger, lockTimeoutMs: 2_000 }),
        migrateDatabase({ url: testPgUrl(), schema: free, logger: recordingLogger() }),
      ]);
      expect(waited.status).toBe("rejected");
      const reason = (waited as PromiseRejectedResult).reason as Error;
      expect(reason).toBeInstanceOf(MigrationFailedError);
      expect(reason.message).toMatch(/timed out after 2s waiting for the migration lock/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
      expect(logger.entries.find((e) => e.msg === "migrations failed")?.fields).toMatchObject({
        causeCode: "MIGRATION_LOCK_TIMEOUT",
      });
      expect(other.status).toBe("fulfilled");
      expect((other as PromiseFulfilledResult<{ applied: string[] }>).value.applied).toEqual(
        MIGRATION_NAMES,
      );
    } finally {
      await holder.end({ timeout: 5 });
    }
  }, 120_000);

  it("a failing migration rejects, releases the lock, and the next call takes it", async () => {
    const schema = await newSchema("failing");
    const logger = recordingLogger();
    const run = migrateDatabase({
      url: testPgUrl(),
      schema,
      logger,
      migrationsFolder: badMigrationsFolder(),
    });
    await expect(run).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(run).rejects.toThrow(/42601/);
    expect(logger.entries.find((e) => e.msg === "migrations failed")?.fields).toMatchObject({
      causeCode: "42601",
    });

    // Another session can take the key at once, so the failed call released it.
    const [probe] = await admin<{ ok: boolean }[]>`
      select pg_try_advisory_lock(${migrationLockKey(schema).toString()}::bigint) as ok`;
    expect(probe!.ok).toBe(true);
    await admin`select pg_advisory_unlock(${migrationLockKey(schema).toString()}::bigint)`;

    const next = await migrateDatabase({ url: testPgUrl(), schema, logger: recordingLogger() });
    expect(next.applied).toEqual(MIGRATION_NAMES);
  }, 120_000);
});
