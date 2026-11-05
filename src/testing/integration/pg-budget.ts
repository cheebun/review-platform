import { DEFAULT_POOL_MAX } from "../../adapters/db/client";

/** Pool size of every `pgSchemaFixture`, so parallel claims genuinely reach the server at once. */
export const MIN_POOL = 10;

/**
 * Connections one integration file may open at its peak. The integration project runs files one
 * at a time (`fileParallelism: false` in vitest.config.ts), so this is also the peak of the run,
 * on top of the global-setup connection.
 *
 * - `pgSchemaFixture` files: MIN_POOL, plus 2 for `container.int.test.ts`'s container pool.
 * - HTTP files: the spawned server's default pool, the harness pool (2) and the test's pool (1).
 *
 * The remote test PostgreSQL is small (max_connections 20, 3 reserved for superusers), so running
 * files in parallel let pools starve each other: a pool then got fewer backends than it asked for
 * and the parallel-claim test saw fewer than MIN_POOL distinct pids.
 */
export const PG_CONNECTION_BUDGET = Math.max(MIN_POOL + 2, DEFAULT_POOL_MAX + 2 + 1);

export type SlotSettings = {
  maxConnections: number;
  superuserReserved: number;
  /** `reserved_connections` (PG 16+), 0 when absent. */
  reserved: number;
  /** Client backends connected right now, including the caller's own. */
  clientBackends: number;
};

/** Connection slots a non-superuser role can still open. */
export function freeConnectionSlots(s: SlotSettings): number {
  return Math.max(0, s.maxConnections - s.superuserReserved - s.reserved - s.clientBackends);
}
