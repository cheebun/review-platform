/**
 * Process-wide runtime for the web server: one lazily created `Container`, shared by every
 * request, closed on SIGTERM/SIGINT.
 *
 * `createRuntime` takes every side effect as a dependency so it is unit-testable; the bottom of
 * the file wires the real ones into the singleton that routes and middleware import.
 */
import { ConsoleLogger } from "../adapters/system/console-logger";
import { redactUrls } from "../adapters/redis/client";
import type { Logger } from "../ports/system";
import { loadConfig, warnDeprecatedKeys, type Config } from "./config";
import { createContainer, type Container } from "./container";

type Env = Record<string, string | undefined>;

export interface RuntimeDeps {
  env: Env;
  loadConfig: (env: Env) => Config;
  warnDeprecatedKeys: (env: Env, logger: Logger) => void;
  createContainer: (config: Config) => Promise<Container>;
  logger: Logger;
  process: { once(signal: "SIGTERM" | "SIGINT", fn: () => void): void; exit(code: number): void };
  /** Upper bound for `container.close()` during shutdown. */
  closeTimeoutMs: number;
}

export interface Runtime {
  /** The shared container. Concurrent first callers share one creation; failures are not cached. */
  getContainer(): Promise<Container>;
  /** The validated config the shared container was built from (same retry semantics). */
  getConfig(): Promise<Config>;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 4_000;

/** Message only (never the error object): URLs are redacted, stack and `cause` are dropped. */
function describe(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error));
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  let memo: Promise<{ config: Config; container: Container }> | undefined;
  let signalsRegistered = false;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info("shutting down", { signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), deps.closeTimeoutMs);
      timer.unref?.();
    });
    try {
      const closing = (async () => {
        // A creation still in flight is awaited so its connections are not leaked.
        const started = await memo?.catch(() => undefined);
        await started?.container.close();
        return "closed" as const;
      })();
      const outcome = await Promise.race([closing, timeout]);
      if (outcome === "timeout") {
        deps.logger.error("container close timed out", { timeoutMs: deps.closeTimeoutMs });
        deps.process.exit(1);
        return;
      }
      deps.process.exit(0);
    } catch (error) {
      deps.logger.error("container close failed", { error: describe(error) });
      deps.process.exit(1);
    } finally {
      clearTimeout(timer);
    }
  };

  const registerSignals = (): void => {
    if (signalsRegistered) return;
    signalsRegistered = true;
    deps.process.once("SIGTERM", () => void shutdown("SIGTERM"));
    deps.process.once("SIGINT", () => void shutdown("SIGINT"));
  };

  const create = async () => {
    const config = deps.loadConfig(deps.env);
    deps.warnDeprecatedKeys(deps.env, deps.logger);
    return { config, container: await deps.createContainer(config) };
  };

  const started = () => {
    registerSignals();
    if (memo) return memo;
    const attempt = create();
    memo = attempt;
    attempt.catch((error: unknown) => {
      deps.logger.error("container startup failed", { error: describe(error) });
      // Only clear our own attempt, so a newer one is never discarded.
      if (memo === attempt) memo = undefined;
    });
    return attempt;
  };

  return {
    getContainer: async () => (await started()).container,
    getConfig: async () => (await started()).config,
  };
}

// The one place besides config.ts that hands `process.env` to loadConfig.
const realDeps = (): RuntimeDeps => ({
  // oxlint-disable-next-line no-restricted-properties
  env: process.env,
  loadConfig,
  warnDeprecatedKeys,
  createContainer: (config) => createContainer(config),
  logger: new ConsoleLogger(),
  process: {
    once: (signal, fn) => void process.once(signal, fn),
    exit: (code) => process.exit(code),
  },
  closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
});

const RUNTIME_KEY = Symbol.for("agent-ops.runtime");
type GlobalWithRuntime = typeof globalThis & { [RUNTIME_KEY]?: Runtime };

/** Kept on `globalThis` so dev-server module reloads do not create a second container. */
function singleton(): Runtime {
  const g = globalThis as GlobalWithRuntime;
  return (g[RUNTIME_KEY] ??= createRuntime(realDeps()));
}

export function getContainer(): Promise<Container> {
  return singleton().getContainer();
}

export function getConfig(): Promise<Config> {
  return singleton().getConfig();
}
