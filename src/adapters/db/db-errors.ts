export const NOT_MIGRATED_MESSAGE = "database not migrated: run pnpm db:migrate";

/** PostgreSQL SQLSTATE 42P01 = undefined_table. */
const UNDEFINED_TABLE = "42P01";

/**
 * The migrate hint when `error` (or anything in its `cause` chain) is a missing-table error,
 * else undefined. Drizzle wraps driver errors as "Failed query: ..." with the driver error as
 * `cause`, so the raw message alone says nothing useful. Never returns the original message.
 */
export function notMigratedMessage(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === UNDEFINED_TABLE) return NOT_MIGRATED_MESSAGE;
    current = current.cause;
  }
  return undefined;
}
