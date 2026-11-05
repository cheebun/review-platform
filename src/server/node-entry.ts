/**
 * Nitro server entry for `vite build` (node-server preset): migrate, then start Nitro's own
 * node-server entry. Wired in vite.config.ts (`entry`, build only).
 *
 * Why not the boot plugin: in Nitro 3 (3.0.261102-rc) an async plugin does not delay listen. The
 * generated `initNitroPlugins` hands a plugin's promise to `initAsyncPlugins`
 * (`nitro/dist/runtime/internal/async-plugins.mjs`), which only gates `h3.config.onRequest` on
 * `app.ready`, while `presets/node/runtime/node-server.mjs` calls `serve()` right after
 * `useNitroApp()`. So the socket would listen before the plugin settled. Here Nitro's entry is
 * imported only after migrations resolve; on failure the process exits 1 and never listens.
 *
 * The migrations are copied next to this file (`.output/server/drizzle`) by the `compiled` hook in
 * vite.config.ts, so the output is self-contained.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConsoleLogger } from "../adapters/system/console-logger";
import { migrateFromEnv, startAfterMigrations } from "./migrate-on-boot";

const logger = new ConsoleLogger().child({ process: "web" });

await startAfterMigrations({
  migrate: () =>
    migrateFromEnv({
      // oxlint-disable-next-line no-restricted-properties
      env: process.env,
      logger,
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "drizzle"),
    }),
  listen: () => import("#agent-ops/nitro-node-server"),
  exit: (code) => process.exit(code),
  logger,
});
