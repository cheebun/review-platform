import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inject } from "vitest";
import { sql } from "drizzle-orm";
import { createPgDb, migrate } from "../../adapters/db/client";
import { createClient } from "redis";
import { withoutCredentialEnv } from "../credential-env";
import { redact } from "./redact";
import { testPgUrl, testRedisUrl } from "./urls";

/**
 * Black-box HTTP harness: builds the app once, spawns `.output/server/index.mjs` against a
 * per-file schema (`test_<runId>_http`) and Redis prefix (`test:<runId>:http:`).
 *
 * Why a per-file fixture instead of a global setup: only `tests/http/**` needs the server, and
 * a global setup would build and boot it for every integration run (PG/Redis-only files too).
 * The shared global setup still provides `runId`, so cleanup and stale-schema sweeps keep working.
 */

const ENTRY = ".output/server/index.mjs";
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 8_000;

export interface CookieJar {
  /** Stores cookies from a response's Set-Cookie headers. */
  store(res: Response): void;
  /** Value for the Cookie request header ("" when empty). Never log this. */
  header(): string;
  clear(): void;
}

export function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    store(res) {
      for (const line of res.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "") cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    clear: () => cookies.clear(),
  };
}

export interface StopResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
}

export interface AppServer {
  baseUrl: string;
  cookieJar(): CookieJar;
  logFile: string;
  /** Per-run schema the server was migrated into (for direct SQL assertions). */
  schema: string;
  /** Sends SIGTERM and waits for exit. Idempotent: later calls return the first result. */
  stop(): Promise<StopResult>;
  /** Drops the schema, unlinks the Redis prefix and stops the server if still running. */
  dispose(): Promise<void>;
}

export interface StartOptions {
  /** Test seam for the harness self-test: spawn this command instead of the built app (no build, no DB). */
  command?: { file: string; args: string[] };
}

const b64 = () => randomBytes(32).toString("base64");

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tail(file: string, lines: number, secrets: string[]): string {
  try {
    const text = readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
    return redact(text, secrets).replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "<redacted-token>");
  } catch {
    return "(no log)";
  }
}

function build(logFile: string): void {
  if (process.env.REUSE_BUILD === "1" && existsSync(resolve(ENTRY))) return;
  const fd = openSync(logFile, "a");
  try {
    const res = spawnSync("pnpm", ["build"], {
      stdio: ["ignore", fd, fd],
      timeout: 300_000,
      // vitest sets NODE_ENV=test, which makes vite emit dev-only JSX (jsxDEV) that crashes SSR.
      // The build never needs Jira or LLM credentials.
      env: { ...withoutCredentialEnv(process.env), NODE_ENV: "production" },
    });
    if (res.status !== 0) {
      throw new Error(
        `pnpm build failed (status ${res.status}). Last log lines:\n${tail(logFile, 40, [])}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

export async function startAppServer(opts: StartOptions = {}): Promise<AppServer> {
  const selfTest = opts.command !== undefined;
  const runId = selfTest ? "selftest" : inject("runId");
  if (!/^[a-z0-9]+$/.test(runId)) throw new Error("unexpected runId shape");
  const schema = `test_${runId}_http`;
  const redisPrefix = `test:${runId}:http:`;
  const logFile = join(tmpdir(), `app-server-${runId}-${randomBytes(4).toString("hex")}.log`);

  const port = await freePort();
  const authSecret = b64();
  const baseUrl = `http://127.0.0.1:${port}`;

  let secrets: string[] = [authSecret];
  let cleanupDb: () => Promise<void> = async () => {};
  let env: NodeJS.ProcessEnv;

  if (selfTest) {
    env = { PATH: process.env.PATH, PORT: String(port), HOST: "127.0.0.1" };
  } else {
    const pgUrl = testPgUrl();
    const redisUrl = testRedisUrl();
    secrets = [...secrets, pgUrl, redisUrl];
    build(logFile);

    const pg = createPgDb({ url: pgUrl, searchPath: schema, max: 2 });
    cleanupDb = async () => {
      const errors: string[] = [];
      try {
        await pg.db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
      } catch (e) {
        errors.push(redact(String(e), secrets));
      }
      await pg.close().catch(() => {});
      const redis = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
      redis.on("error", () => {});
      try {
        await redis.connect();
        const keys: string[] = [];
        for await (const batch of redis.scanIterator({ MATCH: `${redisPrefix}*`, COUNT: 200 })) {
          keys.push(...(Array.isArray(batch) ? batch : [batch]));
        }
        if (keys.length) await redis.unlink(keys);
      } catch (e) {
        errors.push(redact(String(e), secrets));
      } finally {
        await redis.quit().catch(() => {});
      }
      if (errors.length) throw new Error(`app-server cleanup failed: ${errors.join("; ")}`);
    };
    try {
      await pg.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
      // schema is test_[a-z0-9]+_http, so inlining in COMMENT is safe.
      await pg.db.execute(
        sql.raw(`COMMENT ON SCHEMA "${schema}" IS '${new Date().toISOString()}'`),
      );
      await migrate(pg.db, { migrationsSchema: schema });
    } catch (e) {
      await cleanupDb().catch(() => {});
      throw new Error(`app-server schema setup failed: ${redact(String(e), secrets)}`);
    }

    env = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      DATABASE_URL: pgUrl,
      DATABASE_SEARCH_PATH: schema,
      REDIS_URL: redisUrl,
      REDIS_KEY_PREFIX: redisPrefix,
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: baseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
    };
  }

  const fd = openSync(logFile, "a");
  const cmd = opts.command ?? { file: process.execPath, args: [ENTRY] };
  const child: ChildProcess = spawn(cmd.file, cmd.args, { env, stdio: ["ignore", fd, fd] });
  closeSync(fd);

  let exit: { code: number | null; signal: NodeJS.Signals | null; at: number } | undefined;
  child.once("exit", (code, signal) => {
    exit = { code, signal, at: Date.now() };
  });
  child.once("error", () => {
    exit ??= { code: null, signal: null, at: Date.now() };
  });

  let stopped: Promise<StopResult> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      const started = Date.now();
      if (!exit) child.kill("SIGTERM");
      while (!exit && Date.now() - started < STOP_TIMEOUT_MS) await sleep(20);
      if (!exit) {
        child.kill("SIGKILL");
        return { code: null, signal: "SIGKILL" as const, ms: Date.now() - started };
      }
      return { code: exit.code, signal: exit.signal, ms: exit.at - started };
    })());

  const dispose = async () => {
    await stop();
    await cleanupDb();
  };

  // Readiness: poll the public endpoint.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline && !exit) {
    try {
      const res = await fetch(`${baseUrl}/api/auth/ok`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      await res.arrayBuffer();
      // Any HTTP answer proves the listener is up; a 404 (route not implemented yet) is a test failure, not a boot failure.
      ready = true;
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!ready) {
    const why = exit
      ? `server exited early (code ${exit.code}, signal ${exit.signal})`
      : "server not ready within 30 s";
    const log = tail(logFile, 40, secrets);
    await dispose().catch(() => {});
    throw new Error(`app-server: ${why}. Last log lines:\n${log}`);
  }

  return {
    baseUrl,
    cookieJar: createCookieJar,
    logFile,
    schema,
    stop,
    dispose,
  };
}

export interface BootResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  /** Redacted combined stdout/stderr, with every secret value removed. */
  output: string;
  /** True when the raw output contained any of the real secret values (must be false). */
  leaked: boolean;
}

/**
 * Spawns the already-built server with the given env keys removed and waits for it to exit.
 * Requires a prior `startAppServer()` in the same run (it owns the build). Never starts a DB schema.
 */
export async function bootWithout(omit: string[], timeoutMs = 15_000): Promise<BootResult> {
  if (!existsSync(resolve(ENTRY))) throw new Error("bootWithout: build output missing");
  const runId = inject("runId");
  if (!/^[a-z0-9]+$/.test(runId)) throw new Error("unexpected runId shape");
  const pgUrl = testPgUrl();
  const redisUrl = testRedisUrl();
  const port = await freePort();
  const authSecret = b64();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    DATABASE_URL: pgUrl,
    DATABASE_SEARCH_PATH: `test_${runId}_http`,
    REDIS_URL: redisUrl,
    REDIS_KEY_PREFIX: `test:${runId}:boot:`,
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    HOST: "127.0.0.1",
    PORT: String(port),
  };
  for (const key of omit) delete env[key];
  const secrets = [authSecret, pgUrl, redisUrl];
  const logFile = join(tmpdir(), `app-boot-${runId}-${randomBytes(4).toString("hex")}.log`);
  const fd = openSync(logFile, "a");
  const started = Date.now();
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      res({ code, signal });
    });
  });
  let raw = "";
  try {
    raw = readFileSync(logFile, "utf8");
  } catch {
    // no log
  }
  const leaked = secrets.some((s) => s !== "" && raw.includes(s));
  return {
    ...exit,
    ms: Date.now() - started,
    output: redact(raw, secrets).replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "<redacted-token>"),
    leaked,
  };
}
