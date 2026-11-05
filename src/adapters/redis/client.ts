import { createClient } from "redis";
import type { Logger } from "../../ports/system";
import { scripts } from "./scripts";

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi;

/** Removes connection strings from text before it is logged. */
export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, "<redacted-url>");
}

function describeError(error: unknown): { error: string; code?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return { error: redactUrls(message), ...(typeof code === "string" ? { code } : {}) };
}

function buildClient(url: string, connectTimeoutMs: number) {
  return createClient({
    url,
    scripts,
    // Commands fail fast while disconnected instead of queueing, so Lock and EventDedupe fail closed.
    disableOfflineQueue: true,
    pingInterval: 15_000,
    socket: {
      connectTimeout: connectTimeoutMs,
      // Exponential backoff with jitter, capped at 5 s. Never gives up: the process outlives outages.
      reconnectStrategy: (retries) =>
        Math.min(50 * 2 ** Math.min(retries, 7), 5_000) + Math.floor(Math.random() * 100),
    },
  });
}

export type RedisClient = ReturnType<typeof buildClient>;

export class RedisTimeoutError extends Error {
  constructor(ms: number) {
    super(`Redis command timed out after ${ms}ms`);
    this.name = "RedisTimeoutError";
  }
}

/** Rejects with RedisTimeoutError when `op` does not settle in time. The timer is always cleared. */
export async function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedisTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Redis {
  client: RedisClient;
  /** Applies the configured prefix. Every key and pub/sub channel must go through this. */
  key(name: string): string;
  /** A new connected client with the same configuration (for pub/sub). Closed by `close()`. */
  duplicate(): Promise<RedisClient>;
  /** Runs a command with the command timeout. Adapters use this for every call. */
  exec<T>(op: (client: RedisClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CreateRedisOptions {
  url: string;
  keyPrefix: string;
  logger: Logger;
  /** Socket connect timeout. Default 10 s. */
  connectTimeoutMs?: number;
  /** Per-command timeout. Default 5 s. */
  commandTimeoutMs?: number;
}

export async function createRedis(options: CreateRedisOptions): Promise<Redis> {
  const { url, keyPrefix, logger } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
  if (typeof keyPrefix !== "string") throw new TypeError("keyPrefix must be a string");
  const log = logger.child({ component: "redis" });

  const open: RedisClient[] = [];
  const attach = (client: RedisClient, role: string) => {
    client.on("error", (error) =>
      log.error("redis client error", { role, ...describeError(error) }),
    );
    client.on("reconnecting", () => log.warn("redis reconnecting", { role }));
    client.on("ready", () => log.info("redis ready", { role }));
    open.push(client);
  };
  /** Connects within a hard deadline, because the reconnect strategy never gives up. */
  const connect = async (client: RedisClient, role: string): Promise<void> => {
    attach(client, role);
    try {
      await withTimeout(client.connect(), connectTimeoutMs * 2);
    } catch (error) {
      client.destroy();
      open.splice(open.indexOf(client), 1);
      throw new Error(`Redis connect failed (${role}): ${describeError(error).error}`);
    }
  };

  const client = buildClient(url, connectTimeoutMs);
  await connect(client, "primary");

  return {
    client,
    key: (name) => `${keyPrefix}${name}`,
    async duplicate() {
      const dup = client.duplicate();
      await connect(dup, "duplicate");
      return dup;
    },
    exec: (op) => withTimeout(op(client), commandTimeoutMs),
    async close() {
      const clients = open.splice(0);
      await Promise.allSettled(
        clients.map(async (c) => {
          try {
            await c.close();
          } catch {
            c.destroy();
          }
        }),
      );
    },
  };
}
