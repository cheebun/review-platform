import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { SequenceIdGenerator } from "../../testing/fakes/sequence-id-generator";
import { redactUrls, RedisTimeoutError, withTimeout } from "./client";
import type { Redis, RedisClient } from "./client";
import { RedisEventDedupe } from "./redis-event-dedupe";
import { RedisRateLimiter } from "./redis-rate-limiter";
import { RedisThrottle } from "./redis-throttle";
import { RedisWakeUp } from "./redis-wake-up";

const SECRET_URL = "rediss://user:hunter2@redis.example.com:1234";

/** A client whose every command rejects, as when Redis is down. */
function downRedis(): Redis {
  const failing = new Proxy(
    {},
    {
      get: () => () => Promise.reject(new Error(`ECONNREFUSED ${SECRET_URL}`)),
    },
  ) as unknown as RedisClient;
  return {
    client: failing,
    key: (name) => `p:${name}`,
    duplicate: () => Promise.reject(new Error(`ECONNREFUSED ${SECRET_URL}`)),
    exec: (op) => op(failing),
    close: async () => {},
  };
}

describe("Redis adapters fail closed when Redis is down", () => {
  it("EventDedupe.claim throws instead of returning true", async () => {
    await expect(new RedisEventDedupe(downRedis()).claim("e", 1000)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("RateLimiter.hit throws instead of allowing", async () => {
    const limiter = new RedisRateLimiter(downRedis(), new FakeClock(), new SequenceIdGenerator());
    await expect(limiter.hit("k", { limit: 1, windowMs: 1000 })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("Throttle.tryPass throws instead of passing", async () => {
    await expect(new RedisThrottle(downRedis()).tryPass("n", 1000)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("WakeUp.notify swallows the error and logs a redacted warning", async () => {
    const logger = new MemoryLogger();
    await expect(new RedisWakeUp(downRedis(), logger).notify("c")).resolves.toBeUndefined();
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]!.level).toBe("warn");
    expect(JSON.stringify(logger.entries)).not.toContain("hunter2");
  });

  it("WakeUp.subscribe rejects when the subscriber cannot connect, and does not cache the failure", async () => {
    const wake = new RedisWakeUp(downRedis(), new MemoryLogger());
    await expect(wake.subscribe("c", () => {})).rejects.toThrow();
    await expect(wake.subscribe("c", () => {})).rejects.toThrow();
  });
});

describe("input validation", () => {
  it("rejects non-integer or non-positive TTLs before touching Redis", async () => {
    const redis = downRedis();
    await expect(new RedisEventDedupe(redis).claim("e", 1.5)).rejects.toThrow(RangeError);
    await expect(new RedisThrottle(redis).tryPass("n", -1)).rejects.toThrow(RangeError);
    await expect(
      new RedisRateLimiter(redis, new FakeClock(), new SequenceIdGenerator()).hit("k", {
        limit: 0,
        windowMs: 10,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("helpers", () => {
  it("withTimeout rejects a command that never settles", async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toBeInstanceOf(RedisTimeoutError);
  });

  it("withTimeout passes the result through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it("redactUrls strips connection strings", () => {
    expect(redactUrls(`connect ${SECRET_URL} failed`)).toBe("connect <redacted-url> failed");
  });
});
