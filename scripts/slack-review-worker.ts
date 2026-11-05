/**
 * The Slack review worker (FR-SLACK-12), `agent-ops-slack-worker`:
 *   pnpm slack:review
 *
 * Runs the review job consumer and reaction outbox drainer for HTTP Events API jobs.
 *
 * It migrates first, through the same `migrateDatabase` as the web server: whichever process
 * starts first migrates under the advisory lock and the other waits, so the consumers never run
 * against a stale schema. A failed migration exits 1 before any consumer starts.
 *
 * The loops live in `src/server/slack-review-worker.ts`. SIGINT / SIGTERM stop accepting events,
 * let running work finish within a grace period, and close every connection.
 */
import { hostname } from "node:os";
import { ConsoleLogger } from "../src/adapters/system/console-logger";
import { ConfigError, loadConfig, warnDeprecatedKeys } from "../src/server/config";
import { createContainer } from "../src/server/container";
import { loadLocalEnv } from "../src/server/local-env";
import { MigrationFailedError, migrateDatabase } from "../src/server/migrate-on-boot";
import { slackServicesFor } from "../src/server/slack-features";
import { startSlackReviewWorker } from "../src/server/slack-review-worker";

const GRACE_MS = 20_000;

async function main(): Promise<number> {
  loadLocalEnv({ cwd: process.cwd() });
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // ConfigError names variables and reasons only, never values.
    console.error(error instanceof ConfigError ? error.message : "Could not load configuration.");
    return 1;
  }
  try {
    await migrateDatabase({
      url: config.databaseUrl,
      logger: new ConsoleLogger().child({ process: "slack-review-worker" }),
      ...(config.databaseSearchPath ? { schema: config.databaseSearchPath } : {}),
    });
  } catch (error) {
    // Already logged with the Postgres code; the message is value-free by construction.
    console.error(
      "slack review worker not started:",
      error instanceof MigrationFailedError ? error.message : "migrations failed",
    );
    return 1;
  }
  const container = await createContainer(config);
  const { ports } = container;
  const logger = ports.logger.child({ process: "slack-review-worker" });
  warnDeprecatedKeys(process.env, logger);

  const services = slackServicesFor(ports, { appUrl: config.auth.url });
  if (!services) {
    logger.error("slack review ports are not wired; nothing to run");
    await container.close();
    return 1;
  }

  const owner = `${hostname()}:${process.pid}:${ports.ids.uuid().slice(0, 8)}`;
  const worker = await startSlackReviewWorker({
    ports,
    services,
    owner,
  });
  logger.info("slack review worker started", { owner });

  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      logger.info("slack review worker stopping", { signal });
      resolve();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });

  const stopped = await worker.stop({ graceMs: GRACE_MS });
  logger.info("slack review worker stopped", stopped);
  await container.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("slack review worker failed:", error instanceof Error ? error.name : "unknown");
    process.exit(1);
  },
);
