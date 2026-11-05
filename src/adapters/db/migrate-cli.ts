import { ConsoleLogger } from "../system/console-logger";
import { ConfigError } from "../../server/config";
import { loadLocalEnv } from "../../server/local-env";
import { MigrationFailedError, migrateFromEnv } from "../../server/migrate-on-boot";

/**
 * `pnpm db:migrate`: applies `drizzle/` to DATABASE_URL (read through loadConfig, never process.env).
 * With DATABASE_SEARCH_PATH set, tables and the migration journal go into that schema.
 *
 * The same code path as the web server, `pnpm dev` and the worker (they all migrate at startup):
 * `migrateFromEnv` takes the advisory lock, migrates and logs what it applied.
 */
async function main(): Promise<void> {
  loadLocalEnv({ cwd: process.cwd() });
  await migrateFromEnv({
    // oxlint-disable-next-line no-restricted-properties
    env: process.env,
    logger: new ConsoleLogger().child({ process: "db:migrate" }),
  });
}

main().catch((error: unknown) => {
  // Both messages are value-free by construction (variable names, Postgres code and sanitized text).
  console.error(
    error instanceof ConfigError || error instanceof MigrationFailedError
      ? error.message
      : "migration failed",
  );
  process.exitCode = 1;
});
