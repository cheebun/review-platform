import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  migrate as migratePgCore,
  type PgAsyncDatabase,
  type PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolve } from "node:path";

/** Driver-neutral database handle. Repositories depend on this, never on a concrete driver. */
export type Db = PgAsyncDatabase<PgQueryResultHKT, any>;

export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, "../../../drizzle");

export const DEFAULT_POOL_MAX = 10;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalHost(url: string): boolean {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

/** Strips anything that could carry a credential out of an error message. */
export function redactUrl(text: string, url: string): string {
  let out = text.split(url).join("<redacted-url>");
  try {
    const u = new URL(url);
    for (const secret of [u.password, decodeURIComponent(u.password), u.username]) {
      if (secret) out = out.split(secret).join("<redacted>");
    }
  } catch {
    // not a URL; nothing more to redact
  }
  return out;
}

export type PgDb = {
  db: Db;
  /** Pool size actually configured (asserted by the concurrency tests). */
  poolSize: number;
  close(): Promise<void>;
};

export function createPgDb(opts: {
  url: string;
  searchPath?: string;
  max?: number;
  /** Seconds to wait for a connection. */
  connectTimeout?: number;
}): PgDb {
  const max = opts.max ?? DEFAULT_POOL_MAX;
  const sql = postgres(opts.url, {
    max,
    ssl: isLocalHost(opts.url) ? false : "require",
    connect_timeout: opts.connectTimeout ?? 20,
    idle_timeout: 30,
    onnotice: () => {},
    ...(opts.searchPath ? { connection: { search_path: opts.searchPath } } : {}),
  });
  const db = drizzlePg({ client: sql }) as unknown as Db;
  return { db, poolSize: max, close: () => sql.end({ timeout: 5 }) };
}

export type PgliteHandle = { db: Db; client: PGlite; close(): Promise<void> };

/** In-process Postgres for the db-fast project. One instance per test file. */
export async function createPgliteDb(): Promise<PgliteHandle> {
  const client = new PGlite();
  await client.waitReady;
  const db = drizzlePglite({ client }) as unknown as Db;
  return { db, client, close: () => client.close() };
}

/**
 * Applies `drizzle/` to the connection's `search_path`; the journal table lives in
 * `migrationsSchema` (default `drizzle`). Uses the driver-neutral migrator, so it works
 * for both postgres-js and PGlite handles.
 */
export async function migrate(
  db: Db,
  opts: { migrationsSchema?: string; migrationsFolder?: string } = {},
): Promise<void> {
  const config = {
    migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_FOLDER,
    ...(opts.migrationsSchema ? { migrationsSchema: opts.migrationsSchema } : {}),
  };
  await migratePgCore(readMigrationFiles(config), db as never, config);
}
