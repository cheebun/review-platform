import { createHash } from "node:crypto";
import { afterAll, beforeAll, inject } from "vitest";
import { createRedis, redactUrls } from "../../adapters/redis/client";
import type { Redis } from "../../adapters/redis/client";
import type { EventDedupe } from "../../ports/event-dedupe";
import type { Throttle } from "../../ports/throttle";
import { MemoryLogger } from "../fakes/memory-logger";
import { sleep } from "../contracts/harness";
import type { ContractHarness } from "../contracts/harness";
import { testRedisUrl } from "./urls";

/** Extra real time slept on top of every `advance`, so TTLs have certainly expired. */
const ADVANCE_MARGIN_MS = 20;

/** Same client and connections, but every key gets an extra per-test segment. */
export function scoped(redis: Redis, segment: string): Redis {
  return { ...redis, key: (name) => redis.key(`${segment}:${name}`), close: async () => {} };
}

/**
 * Per-file Redis environment: prefix `test:<runId>:<file hash>:`, a connected client, and a
 * SCAN + UNLINK cleanup of that prefix in afterAll. Never FLUSHDB / FLUSHALL.
 */
export function useRedisTestEnv(file: string) {
  const prefix = `${inject("redisPrefix")}${createHash("sha1").update(file).digest("hex").slice(0, 8)}:`;
  let redis: Redis | undefined;
  let counter = 0;

  beforeAll(async () => {
    redis = await createRedis({
      url: testRedisUrl(),
      keyPrefix: prefix,
      logger: new MemoryLogger(),
    });
  });

  afterAll(async () => {
    if (!redis) return;
    try {
      const keys: string[] = [];
      for await (const batch of redis.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
        keys.push(...(Array.isArray(batch) ? batch : [batch]));
      }
      if (keys.length) await redis.client.unlink(keys);
    } catch (error) {
      throw new Error(`Redis test cleanup failed: ${redactUrls(String(error))}`);
    } finally {
      await redis.close();
    }
  });

  return {
    prefix,
    /** A fresh key namespace for each contract test, so tests cannot see each other's keys. */
    fresh(): Redis {
      if (!redis) throw new Error("Redis test env is not connected (beforeAll has not run)");
      counter += 1;
      return scoped(redis, `t${counter}`);
    },
  };
}

/**
 * Contract TTLs are a few hundred ms, but the remote Redis round trip is ~120 ms, so a test with
 * three sequential calls would outlive a 300 ms TTL. Every TTL the adapter sees, and every
 * `advance`, is multiplied by this factor. Ratios are unchanged, only the round trip shrinks
 * relative to the TTLs.
 */
export const TIME_SCALE = 4;

/** Real adapters expire on real time, so `advance` sleeps. `impl` must scale TTLs itself. */
export async function realTimeHarness<T>(impl: T): Promise<ContractHarness<T>> {
  return {
    impl,
    advance: (ms) => sleep(ms * TIME_SCALE + ADVANCE_MARGIN_MS),
    cleanup: async () => {},
  };
}

export function scaleEventDedupe(dedupe: EventDedupe): EventDedupe {
  return { claim: (id, ttlMs) => dedupe.claim(id, ttlMs * TIME_SCALE) };
}

export function scaleThrottle(throttle: Throttle): Throttle {
  return { tryPass: (name, ms) => throttle.tryPass(name, ms * TIME_SCALE) };
}
