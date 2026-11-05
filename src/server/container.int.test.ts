import { expect, it } from "vitest";
import { createPgDb, type PgDb } from "../adapters/db/client";
import { createRedis, type Redis } from "../adapters/redis/client";
import { aNewReviewJob } from "../testing/builders/review-job";
import { pgSchemaFixture } from "../testing/integration/pg-fixture";
import { useRedisTestEnv } from "../testing/integration/redis-harness";
import { testPgUrl, testRedisUrl } from "../testing/integration/urls";
import { loadConfig } from "./config";
import { createContainer } from "./container";

const fixture = pgSchemaFixture(import.meta.url);
const redisEnv = useRedisTestEnv(import.meta.filename);

it("wires real Postgres and Redis ports and closes every handle", async () => {
  const config = loadConfig({
    DATABASE_URL: testPgUrl(),
    REDIS_URL: testRedisUrl(),
    REDIS_KEY_PREFIX: `${redisEnv.prefix}c:`,
    BETTER_AUTH_SECRET: "a".repeat(32),
    BETTER_AUTH_URL: "http://localhost:3000",
  });
  let pg: PgDb | undefined;
  let redis: Redis | undefined;
  const container = await createContainer(
    config,
    {},
    {
      // Same remote server, but into this file's schema, so tables exist and nothing leaks.
      createPgDb: (o) => (pg = createPgDb({ ...o, searchPath: fixture.schema, max: 2 })),
      createRedis: async (o) => (redis = await createRedis(o)),
    },
  );
  const { ports } = container;

  const created = await ports.reviewJobs.create(aNewReviewJob({ id: "int-job" }));
  expect(created.ok).toBe(true);
  const claimed = await ports.reviewJobs.claimNext({ owner: "w1", leaseMs: 10_000 });
  expect(claimed?.id).toBe("int-job");

  expect(await ports.auth.getSessionActor(new Headers())).toBeNull();
  expect(
    await ports.attemptLimiter.attempt("int-ip", { limit: 2, windowMs: 10_000, lockoutMs: 10_000 }),
  ).toEqual({ allowed: true, retryAfterMs: 0 });

  expect(await ports.eventDedupe.claim("int-event", 10_000)).toBe(true);
  expect(await ports.eventDedupe.claim("int-event", 10_000)).toBe(false);

  // Keys went under the configured prefix.
  const keys: string[] = [];
  for await (const batch of redis!.client.scanIterator({ MATCH: `${config.redisKeyPrefix}*` })) {
    keys.push(...(Array.isArray(batch) ? batch : [batch]));
  }
  expect(keys.length).toBeGreaterThan(0);

  expect(redis!.client.isOpen).toBe(true);
  await container.close();
  await container.close();

  // No open handles: the redis client is closed and the pg pool refuses new queries.
  expect(redis!.client.isOpen).toBe(false);
  await expect(pg!.db.execute("select 1" as never)).rejects.toThrow();
}, 60_000);
