import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { reviewJobRepoContract } from "../../testing/contracts/review-job-repo.contract";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { MIN_POOL, pgSchemaFixture } from "../../testing/integration/pg-fixture";
import { PgReviewJobRepo } from "./pg-review-job-repo";

const fixture = pgSchemaFixture(import.meta.url);

reviewJobRepoContract(async () => {
  const clock = new FakeClock();
  return {
    repo: new PgReviewJobRepo(fixture.db(), clock),
    advance: (ms) => clock.advance(ms),
    cleanup: async () => {},
  };
});

it("uses a pool that really runs queries in parallel (so SKIP LOCKED is exercised)", async () => {
  const db = fixture.db();
  expect(fixture.pool().poolSize).toBeGreaterThanOrEqual(MIN_POOL);
  // Warm the pool so connection setup (TLS, auth) is not part of the measured overlap. Each warm-up
  // query holds its connection briefly, so all MIN_POOL connections are opened concurrently; bare
  // SELECT 1 queries finish too fast and one connection can serve several of them.
  await Promise.all(Array.from({ length: MIN_POOL }, () => db.execute(sql`SELECT pg_sleep(0.2)`)));
  // Start and end clocks are taken on the server. The CTE data dependency orders them:
  // `a` reads the start clock before `slept` runs pg_sleep, and the outer clock is read after it.
  const results = (await Promise.all(
    Array.from({ length: MIN_POOL }, () =>
      db.execute(sql`
        WITH a AS (SELECT pg_backend_pid() AS pid, clock_timestamp() AS s),
             slept AS (SELECT a.pid, a.s, pg_sleep(0.5) AS slept FROM a)
        SELECT pid,
               extract(epoch FROM s)::float8 AS s,
               extract(epoch FROM clock_timestamp())::float8 AS e
        FROM slept`),
    ),
  )) as unknown as { pid: number; s: number; e: number }[][];
  const rows = results.flat();
  expect(rows).toHaveLength(MIN_POOL);
  // Each query must hold its own connection, so at least MIN_POOL distinct backends.
  expect(new Set(rows.map((r) => r.pid)).size).toBeGreaterThanOrEqual(MIN_POOL);
  // Every interval must overlap: all queries started before any of them finished.
  expect(Math.max(...rows.map((r) => r.s))).toBeLessThan(Math.min(...rows.map((r) => r.e)));
});

it("isolates the run: migrations journal and tables live in the per-file schema", async () => {
  const rows = (await fixture
    .db()
    .execute(
      sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = ${fixture.schema}`,
    )) as unknown as { n: number }[];
  expect(rows[0]?.n).toBeGreaterThanOrEqual(8);
});
