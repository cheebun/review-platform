import { describe, expect, it, vi } from "vitest";
import type { Db } from "../adapters/db/client";
import type { LogFields, Logger } from "../ports/system";
import { ConfigError } from "./config";
import {
  MIGRATION_LOCK_TIMEOUT_MS,
  MigrationFailedError,
  migrateOnBoot,
  migrateForDev,
  migrationLockKey,
  startAfterMigrations,
  type LockSession,
} from "./migrate-on-boot";

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

/** A database handle that fails the test if migrateOnBoot touches it. */
const untouchableDb = new Proxy({} as Db, {
  get: (_t, prop) => {
    throw new Error(`db.${String(prop)} must not be used`);
  },
});

describe("migrationLockKey", () => {
  it("is a stable signed 64-bit key per schema", () => {
    const key = migrationLockKey("dev");
    expect(key).toBe(migrationLockKey("dev"));
    expect(key).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(key).toBeLessThan(2n ** 63n);
  });

  it("differs between schemas, so test schemas never block each other", () => {
    expect(migrationLockKey("test_a")).not.toBe(migrationLockKey("test_b"));
    expect(migrationLockKey("public")).not.toBe(migrationLockKey("dev"));
  });
});

describe("migrateOnBoot lock wait", () => {
  it("times out with a clear error, closes the lock session and never migrates", async () => {
    let now = 0;
    const lock: LockSession = {
      tryLock: vi.fn(async () => false),
      unlock: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const logger = recordingLogger();
    const run = migrateOnBoot({
      db: untouchableDb,
      lock,
      schema: "dev",
      logger,
      lockTimeoutMs: 1_000,
      pollMs: 100,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await expect(run).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(run).rejects.toThrow(/timed out after 1s waiting for the migration lock/);
    expect(lock.tryLock).toHaveBeenCalledWith(migrationLockKey("dev"));
    expect(vi.mocked(lock.tryLock).mock.calls.length).toBeGreaterThan(5);
    expect(lock.unlock).not.toHaveBeenCalled();
    expect(lock.close).toHaveBeenCalledOnce();
    const failure = logger.entries.find((e) => e.msg === "migrations failed");
    expect(failure?.level).toBe("error");
    expect(failure?.fields).toMatchObject({
      schema: "dev",
      causeCode: "MIGRATION_LOCK_TIMEOUT",
    });
  });

  it("defaults to a 60 s bound", () => {
    expect(MIGRATION_LOCK_TIMEOUT_MS).toBe(60_000);
  });

  it("closes the lock session when the lock query itself fails", async () => {
    const close = vi.fn(async () => {});
    const run = migrateOnBoot({
      db: untouchableDb,
      lock: {
        tryLock: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
            code: "ECONNREFUSED",
          });
        },
        unlock: async () => {},
        close,
      },
      logger: recordingLogger(),
    });
    await expect(run).rejects.toThrow(/ECONNREFUSED/);
    await expect(run).rejects.not.toThrow(/10\.0\.0\.1/);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an unsafe schema name before taking the lock", async () => {
    const lock: LockSession = {
      tryLock: vi.fn(async () => true),
      unlock: async () => {},
      close: vi.fn(async () => {}),
    };
    await expect(
      migrateOnBoot({ db: untouchableDb, lock, schema: 'x"; drop', logger: recordingLogger() }),
    ).rejects.toThrow(/schema/);
    expect(lock.tryLock).not.toHaveBeenCalled();
    expect(lock.close).toHaveBeenCalledOnce();
  });
});

describe("startAfterMigrations", () => {
  it("does not listen until migrate resolves", async () => {
    const order: string[] = [];
    let release!: () => void;
    const migrate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push("migrated");
            resolve();
          };
        }),
    );
    const listen = vi.fn(async () => {
      order.push("listen");
    });
    const exit = vi.fn();
    const started = startAfterMigrations({ migrate, listen, exit, logger: recordingLogger() });
    await new Promise((r) => setTimeout(r, 10));
    expect(migrate).toHaveBeenCalledOnce();
    expect(listen).not.toHaveBeenCalled();
    release();
    await started;
    expect(order).toEqual(["migrated", "listen"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits 1 and never listens when migrate rejects", async () => {
    const listen = vi.fn(async () => {});
    const exit = vi.fn();
    const logger = recordingLogger();
    await startAfterMigrations({
      migrate: async () => {
        throw new MigrationFailedError("dev", { error: "MigrationError", causeCode: "42601" });
      },
      listen,
      exit,
      logger,
    });
    expect(listen).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
  });

  it("logs only variable names for a config error", async () => {
    const exit = vi.fn();
    const logger = recordingLogger();
    await startAfterMigrations({
      migrate: async () => {
        throw new ConfigError([{ key: "DATABASE_URL", reason: "is required" }]);
      },
      listen: async () => {},
      exit,
      logger,
    });
    expect(exit).toHaveBeenCalledWith(1);
    const entry = logger.entries.find((e) => e.level === "error");
    expect(entry?.fields).toMatchObject({ variables: ["DATABASE_URL"] });
  });
});

describe("migrateForDev (pnpm dev)", () => {
  const validEnv = {
    DATABASE_URL: "postgres://u:hunter2@db.example.com:5432/app",
    REDIS_URL: "rediss://:pw@cache.example.com:6380",
    BETTER_AUTH_SECRET: "a".repeat(40),
    BETTER_AUTH_URL: "http://127.0.0.1:5555",
    DATABASE_SEARCH_PATH: "dev",
  };

  it("migrates with the configured URL and schema", async () => {
    const migrate = vi.fn(async () => {});
    await migrateForDev({ env: () => validEnv, migrate, logger: recordingLogger() });
    expect(migrate).toHaveBeenCalledWith(
      expect.objectContaining({ url: validEnv.DATABASE_URL, schema: "dev" }),
    );
  });

  it("skips migrating on a config error so the boot 503 page can name the keys", async () => {
    const migrate = vi.fn(async () => {});
    const logger = recordingLogger();
    await expect(migrateForDev({ env: () => ({}), migrate, logger })).resolves.toBeUndefined();
    expect(migrate).not.toHaveBeenCalled();
    const warning = logger.entries.find((e) => e.level === "warn");
    expect(warning?.fields).toMatchObject({ variables: expect.arrayContaining(["DATABASE_URL"]) });
  });

  it("stops the dev server with a clean error when migrations fail", async () => {
    const run = migrateForDev({
      env: () => validEnv,
      migrate: async () => {
        throw new MigrationFailedError("dev", {
          error: "MigrationError",
          causeCode: "42601",
          causeMessage: 'syntax error at or near "nonsense"',
        });
      },
      logger: recordingLogger(),
    });
    await expect(run).rejects.toThrow(/migrations failed for schema dev: 42601/);
    const error = (await run.catch((e: unknown) => e)) as Error;
    expect(error.cause).toBeUndefined();
    expect(String(error.message)).not.toContain("hunter2");
  });
});
