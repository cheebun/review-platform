/**
 * Database migrations at process start. The one code path behind the web server
 * (`src/server/node-entry.ts`), `pnpm dev` (`migrateForDev`), the Slack review worker and
 * `pnpm db:migrate`.
 *
 * Whichever process starts first takes a session-level Postgres advisory lock on a dedicated
 * connection, keyed by `agent-ops:migrate:<schema>`, and migrates. The others wait (bounded by
 * MIGRATION_LOCK_TIMEOUT_MS), then find nothing pending. Each schema has its own key, so parallel
 * test schemas never block each other. Drizzle applies all pending migrations in one transaction,
 * so a failure leaves the schema as it was.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createPgDb, isLocalHost, migrate, type Db } from "../adapters/db/client";
import { migrateIntoSchema, SCHEMA_NAME } from "../adapters/db/migrate-schema";
import { ConsoleLogger } from "../adapters/system/console-logger";
import type { Logger } from "../ports/system";
import { ConfigError, loadConfig } from "./config";
import { errorLogFields, type ErrorLogFields } from "./errors";
import { loadLocalEnv } from "./local-env";

/** Upper bound for waiting on another process's migration lock. */
export const MIGRATION_LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 250;
/** Without DATABASE_SEARCH_PATH: tables in `public`, journal in drizzle's default `drizzle`. */
const DEFAULT_TABLE_SCHEMA = "public";
const DEFAULT_JOURNAL_SCHEMA = "drizzle";
const JOURNAL_TABLE = "__drizzle_migrations";

type Env = Record<string, string | undefined>;

/** A dedicated session that holds the advisory lock. `migrateOnBoot` closes it on every path. */
export interface LockSession {
  tryLock(key: bigint): Promise<boolean>;
  unlock(key: bigint): Promise<void>;
  close(): Promise<void>;
}

export type MigrateResult = { applied: string[]; durationMs: number };

/** Signed 64-bit advisory lock key: the first 8 bytes of sha256(`agent-ops:migrate:<schema>`). */
export function migrationLockKey(schema: string): bigint {
  return createHash("sha256").update(`agent-ops:migrate:${schema}`).digest().readBigInt64BE(0);
}

class MigrationLockTimeoutError extends Error {
  override name = "MigrationLockTimeoutError";
  readonly code = "MIGRATION_LOCK_TIMEOUT";
  constructor(timeoutMs: number) {
    super(
      `timed out after ${+(timeoutMs / 1000).toFixed(1)}s waiting for the migration lock (another process is migrating, or is stuck holding it)`,
    );
  }
}

/**
 * The only error migrateOnBoot throws. Its message is built from sanitized fields (Postgres code
 * and value-free message), never from the original error, and it carries no `cause`, so printing
 * it (Vite prints the whole object) cannot leak SQL parameters or a connection string.
 */
export class MigrationFailedError extends Error {
  override name = "MigrationFailedError";
  constructor(
    readonly schema: string,
    readonly fields: ErrorLogFields,
    detail?: string,
  ) {
    const why =
      detail ??
      (fields.causeCode
        ? [fields.causeCode, fields.causeMessage].filter(Boolean).join(" ")
        : (fields.causeName ?? fields.error));
    super(`migrations failed for schema ${schema}: ${why}`);
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
}

/** Names recorded in the journal, in apply order; empty before the first migration. */
async function journalNames(db: Db, journalSchema: string): Promise<string[]> {
  const qualified = `"${journalSchema}".${JOURNAL_TABLE}`;
  const [exists] = rowsOf(await db.execute(sql`select to_regclass(${qualified}::text)::text as t`));
  if (!exists?.t) return [];
  const rows = rowsOf(
    await db.execute(
      sql`select name from ${sql.identifier(journalSchema)}.${sql.identifier(JOURNAL_TABLE)} order by id`,
    ),
  );
  return rows.map((r) => String(r.name));
}

export type MigrateOnBootOptions = {
  /** Migration session (single connection: `search_path` is per session). Owned by the caller. */
  db: Db;
  /** Dedicated lock session. Owned by migrateOnBoot: closed on every path. */
  lock: LockSession;
  /** DATABASE_SEARCH_PATH. Unset: tables in `public`, journal in `drizzle`. */
  schema?: string;
  logger: Logger;
  migrationsFolder?: string;
  lockTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function migrateOnBoot(opts: MigrateOnBootOptions): Promise<MigrateResult> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const timeoutMs = opts.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const started = now();
  const label = opts.schema ?? DEFAULT_TABLE_SCHEMA;
  const log = opts.logger.child({ component: "migrate", schema: label });
  const key = migrationLockKey(label);
  let locked = false;
  try {
    if (opts.schema !== undefined && !SCHEMA_NAME.test(opts.schema)) {
      throw new MigrationFailedError(
        "<invalid>",
        { error: "ConfigError" },
        "invalid schema name (must match ^[a-z_][a-z0-9_]*$)",
      );
    }

    const deadline = started + timeoutMs;
    let announced = false;
    while (!(locked = await opts.lock.tryLock(key))) {
      const left = deadline - now();
      if (left <= 0) throw new MigrationLockTimeoutError(timeoutMs);
      if (!announced) {
        log.info("waiting for the migration lock held by another process", { timeoutMs });
        announced = true;
      }
      await sleep(Math.min(pollMs, left));
    }

    const journalSchema = opts.schema ?? DEFAULT_JOURNAL_SCHEMA;
    const before = new Set(await journalNames(opts.db, journalSchema));
    const folder = opts.migrationsFolder ? { migrationsFolder: opts.migrationsFolder } : {};
    if (opts.schema) await migrateIntoSchema(opts.db, opts.schema, folder);
    else await migrate(opts.db, folder);
    const applied = (await journalNames(opts.db, journalSchema)).filter((n) => !before.has(n));

    const durationMs = Math.round(now() - started);
    if (applied.length > 0) log.info("migrations applied", { applied, durationMs });
    else log.info("migrations up to date", { durationMs });
    return { applied, durationMs };
  } catch (error) {
    const durationMs = Math.round(now() - started);
    if (error instanceof MigrationFailedError) {
      log.error("migrations failed", { ...error.fields, reason: error.message, durationMs });
      throw error;
    }
    // Wrap once so a top-level code (ECONNREFUSED, the lock timeout) is read like a cause's.
    const fields = errorLogFields(
      Object.assign(new Error("migration failed", { cause: error }), { name: "MigrationError" }),
    );
    log.error("migrations failed", { ...fields, durationMs });
    throw new MigrationFailedError(
      label,
      fields,
      error instanceof MigrationLockTimeoutError ? error.message : undefined,
    );
  } finally {
    // Closing the session releases a session lock anyway; unlocking first frees it sooner.
    if (locked) await opts.lock.unlock(key).catch(() => undefined);
    await opts.lock.close().catch(() => undefined);
  }
}

/** A one-connection postgres-js client used only for the advisory lock. */
export function openPgLockSession(url: string): LockSession {
  const client = postgres(url, {
    max: 1,
    ssl: isLocalHost(url) ? false : "require",
    connect_timeout: 20,
    // No idle timeout: dropping the connection would silently drop the lock.
    idle_timeout: 0,
    onnotice: () => {},
  });
  return {
    tryLock: async (key) => {
      const [row] = await client<{ ok: boolean }[]>`
        select pg_try_advisory_lock(${key.toString()}::bigint) as ok`;
      return row?.ok === true;
    },
    unlock: async (key) => {
      await client`select pg_advisory_unlock(${key.toString()}::bigint)`;
    },
    close: () => client.end({ timeout: 5 }),
  };
}

export type MigrateDatabaseOptions = {
  url: string;
  schema?: string;
  logger: Logger;
  migrationsFolder?: string;
  lockTimeoutMs?: number;
};

/** migrateOnBoot on real connections: one lock session and one migration session, both closed. */
export async function migrateDatabase(opts: MigrateDatabaseOptions): Promise<MigrateResult> {
  const pg = createPgDb({
    url: opts.url,
    max: 1,
    ...(opts.schema ? { searchPath: opts.schema } : {}),
  });
  try {
    return await migrateOnBoot({
      db: pg.db,
      lock: openPgLockSession(opts.url),
      logger: opts.logger,
      ...(opts.schema ? { schema: opts.schema } : {}),
      ...(opts.migrationsFolder ? { migrationsFolder: opts.migrationsFolder } : {}),
      ...(opts.lockTimeoutMs !== undefined ? { lockTimeoutMs: opts.lockTimeoutMs } : {}),
    });
  } finally {
    await pg.close().catch(() => undefined);
  }
}

/** Reads DATABASE_URL / DATABASE_SEARCH_PATH through loadConfig and migrates. */
export async function migrateFromEnv(opts: {
  env: Env;
  logger: Logger;
  migrationsFolder?: string;
}): Promise<MigrateResult> {
  const config = loadConfig(opts.env);
  return migrateDatabase({
    url: config.databaseUrl,
    logger: opts.logger,
    ...(config.databaseSearchPath ? { schema: config.databaseSearchPath } : {}),
    ...(opts.migrationsFolder ? { migrationsFolder: opts.migrationsFolder } : {}),
  });
}

const configVariables = (error: ConfigError): string[] => [
  ...new Set(error.issues.map((i) => i.key)),
];

/**
 * Production startup order: migrate, then listen. A rejection logs and exits 1 without ever
 * listening, so the server never serves a stale schema.
 */
export async function startAfterMigrations(deps: {
  migrate: () => Promise<unknown>;
  listen: () => Promise<unknown>;
  exit: (code: number) => void;
  logger: Logger;
}): Promise<void> {
  try {
    await deps.migrate();
  } catch (error) {
    if (error instanceof ConfigError) {
      deps.logger.error("server not started: configuration is invalid", {
        variables: configVariables(error),
      });
    } else if (error instanceof MigrationFailedError) {
      deps.logger.error("server not started: migrations failed", { reason: error.message });
    } else {
      deps.logger.error("server not started: migrations failed", { ...errorLogFields(error) });
    }
    deps.exit(1);
    return;
  }
  try {
    await deps.listen();
  } catch (error) {
    deps.logger.error("server failed to start", { ...errorLogFields(error) });
    deps.exit(1);
  }
}

/** The dev server's env: `.env*` files under real variables, without mutating `process.env`. */
function devEnv(): Env {
  // oxlint-disable-next-line no-restricted-properties
  const env: Env = { ...process.env };
  loadLocalEnv({ cwd: process.cwd(), target: env });
  return env;
}

/**
 * `pnpm dev`: migrates once, from a `pre`-ordered `config` hook of the dev plugin in vite.config.ts.
 * Vite's `runConfigHook` awaits every `config` hook in order (vite 8.3.5 `dist/node/chunks/node.js`)
 * before Nitro's `nitro:init` config hook sets up the dev worker and its boot plugin, and the CLI
 * calls `server.listen()` only after `createServer` resolves (`dist/node/cli.js`). So neither the
 * container nor a request sees the old schema. (`configureServer` is too late: the Nitro dev worker
 * is already booting by then.) A throw makes the CLI print the error and `process.exit(1)`.
 *
 * A config error is not a migration failure: it is skipped here so the boot plugin's 503 page can
 * name the missing keys (see boot-failure.ts).
 */
export async function migrateForDev(
  deps: {
    env?: () => Env;
    migrate?: (opts: MigrateDatabaseOptions) => Promise<unknown>;
    logger?: Logger;
  } = {},
): Promise<void> {
  const logger = (deps.logger ?? new ConsoleLogger()).child({ process: "dev" });
  let config;
  try {
    config = loadConfig((deps.env ?? devEnv)());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    logger.warn("migrations skipped: configuration is invalid", {
      variables: configVariables(error),
    });
    return;
  }
  try {
    await (deps.migrate ?? migrateDatabase)({
      url: config.databaseUrl,
      logger,
      ...(config.databaseSearchPath ? { schema: config.databaseSearchPath } : {}),
    });
  } catch (error) {
    const reason =
      error instanceof MigrationFailedError
        ? error.message
        : `migrations failed: ${errorLogFields(error).error}`;
    // No cause on purpose: Vite inspects the whole error object when it prints it.
    // oxlint-disable-next-line preserve-caught-error
    throw new Error(`${reason}. The dev server is stopping; fix the migration and restart.`);
  }
}
