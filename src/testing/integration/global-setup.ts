import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { createClient } from "redis";
import type { TestProject } from "vitest/node";
import { loadBootstrapTestEnv, scrubCredentialEnv } from "../credential-env";
import { assertNotProduction } from "./guard";
import { PG_CONNECTION_BUDGET, freeConnectionSlots } from "./pg-budget";
import { redact } from "./redact";
import { RUN_SCHEMA, selectStaleSchemas } from "./stale-schemas";

declare module "vitest" {
  export interface ProvidedContext {
    runId: string;
    schema: string;
    redisPrefix: string;
    /** Database name that worked for the remote PostgreSQL (never the URL). */
    pgDatabase: string;
  }
}

const ENV_FILE = ".env.test.local";
const FALLBACK_DATABASES = ["defaultdb"];

type Sql = ReturnType<typeof postgres>;

function secrets(): string[] {
  return [process.env.TEST_DATABASE_URL, process.env.TEST_REDIS_URL].filter(Boolean) as string[];
}

function fail(prefix: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${prefix}: ${redact(message, secrets())}`);
}

/** Connects, appending a fallback database name in code if the URL names a missing one. */
async function connectPg(url: string): Promise<{ sql: Sql; url: string; database: string }> {
  const candidates = [url];
  const parsed = new URL(url);
  for (const name of FALLBACK_DATABASES) {
    const alt = new URL(url);
    alt.pathname = `/${name}`;
    if (alt.pathname !== parsed.pathname) candidates.push(alt.toString());
  }
  let last: unknown;
  for (const candidate of candidates) {
    const sql = postgres(candidate, {
      ssl: "require",
      max: 1,
      connect_timeout: 20,
      onnotice: () => {},
    });
    try {
      const [row] = await sql`select current_database() as db`;
      return { sql, url: candidate, database: String(row.db) };
    } catch (error) {
      last = error;
      await sql.end({ timeout: 1 }).catch(() => {});
      // 3D000 = invalid_catalog_name: the database does not exist, try the next name.
      if ((error as { code?: string }).code !== "3D000") break;
    }
  }
  return fail("Cannot connect to TEST_DATABASE_URL", last);
}

export default async function setup(project: TestProject) {
  const envFile = resolve(process.cwd(), ENV_FILE);
  if (!existsSync(envFile)) {
    throw new Error(
      `${ENV_FILE} is missing. Create it with TEST_DATABASE_URL and TEST_REDIS_URL (see docs/testing.md section 5).`,
    );
  }
  // Bootstrap keys only (DB and Redis). Jira and LLM credentials come from the settings-store
  // fake, never from env: drop any the shell set so workers cannot inherit them.
  scrubCredentialEnv();
  loadBootstrapTestEnv(envFile);
  assertNotProduction(process.env);
  if (!process.env.TEST_REDIS_URL)
    throw new Error("TEST_REDIS_URL is not set (expected in .env.test.local)");
  if (new URL(process.env.TEST_REDIS_URL).protocol !== "rediss:") {
    throw new Error("TEST_REDIS_URL must use the rediss (TLS) scheme");
  }

  const runId = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const schema = `test_${runId}`;
  const redisPrefix = `test:${runId}:`;

  const pg = await connectPg(process.env.TEST_DATABASE_URL!);
  // Workers inherit the resolved URL (with database name) through the environment.
  process.env.TEST_DATABASE_URL = pg.url;

  // Connect once to fail fast, then close: files run one at a time, so the run outlasts the
  // server's idle timeout and a client held open until teardown would be dropped by then.
  const redisUrl = process.env.TEST_REDIS_URL;
  const connectRedis = async () => {
    const client = createClient({
      url: redisUrl,
      socket: { connectTimeout: 20_000, reconnectStrategy: false },
    });
    client.on("error", () => {});
    await client.connect();
    return client;
  };
  try {
    await (await connectRedis()).quit();
  } catch (error) {
    await pg.sql.end({ timeout: 1 }).catch(() => {});
    fail("Cannot connect to TEST_REDIS_URL", error);
  }

  try {
    const rows = await pg.sql<{ name: string; comment: string | null }[]>`
      select n.nspname as name, obj_description(n.oid, 'pg_namespace') as comment
      from pg_namespace n where n.nspname like 'test\\_%'`;
    for (const stale of selectStaleSchemas(rows, new Date())) {
      await pg.sql.unsafe(`drop schema if exists "${stale}" cascade`);
    }
    // Read-only: fail fast with a clear message instead of letting pools silently get fewer
    // backends than they asked for (that made the parallel-claim test flaky).
    const [slots] = await pg.sql<
      { mc: number; sr: number; rc: number | null; clients: number }[]
    >`select current_setting('max_connections')::int as mc,
             current_setting('superuser_reserved_connections')::int as sr,
             current_setting('reserved_connections', true)::int as rc,
             (select count(*)::int from pg_stat_activity where backend_type = 'client backend') as clients`;
    const free = freeConnectionSlots({
      maxConnections: slots.mc,
      superuserReserved: slots.sr,
      reserved: slots.rc ?? 0,
      clientBackends: slots.clients,
    });
    if (free < PG_CONNECTION_BUDGET) {
      throw new Error(
        `test PostgreSQL has ${free} free connection slots, integration files need ${PG_CONNECTION_BUDGET} (max_connections ${slots.mc}, ${slots.clients} clients connected). Close other clients or raise max_connections.`,
      );
    }
    // schema is `test_` + [a-z0-9]+, so interpolation is safe.
    await pg.sql.unsafe(`create schema "${schema}"`);
    await pg.sql.unsafe(`comment on schema "${schema}" is '${new Date().toISOString()}'`);
  } catch (error) {
    await pg.sql.end({ timeout: 1 }).catch(() => {});
    fail("Integration setup failed", error);
  }

  project.provide("runId", runId);
  project.provide("schema", schema);
  project.provide("redisPrefix", redisPrefix);
  project.provide("pgDatabase", pg.database);

  return async function teardown() {
    const errors: string[] = [];
    try {
      await pg.sql.unsafe(`drop schema if exists "${schema}" cascade`);
      // Per-file schemas (`test_<runId>_<hash>`) are dropped by their own afterAll; sweep any that a
      // crashed worker left behind. runId is [a-z0-9]+, so the LIKE pattern and names are safe.
      const leftovers = await pg.sql<{ name: string }[]>`
        select nspname as name from pg_namespace where nspname like ${`${schema}\\_%`}`;
      for (const { name } of leftovers) {
        if (RUN_SCHEMA.test(name)) await pg.sql.unsafe(`drop schema if exists "${name}" cascade`);
      }
    } catch (error) {
      errors.push(redact(String(error), secrets()));
    }
    let redis: Awaited<ReturnType<typeof connectRedis>> | undefined;
    try {
      redis = await connectRedis();
      // SCAN + UNLINK under this run's prefix only. Never FLUSHDB / FLUSHALL.
      const keys: string[] = [];
      for await (const batch of redis.scanIterator({ MATCH: `${redisPrefix}*`, COUNT: 200 })) {
        keys.push(...(Array.isArray(batch) ? batch : [batch]));
      }
      if (keys.length) await redis.unlink(keys);
    } catch (error) {
      errors.push(redact(String(error), secrets()));
    }
    await Promise.allSettled([pg.sql.end({ timeout: 5 }), redis?.quit()]);
    if (errors.length) throw new Error(`Integration teardown failed: ${errors.join("; ")}`);
  };
}
