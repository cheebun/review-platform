export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Run schemas are `test_<runId>`; per-file schemas are `test_<runId>_<fileHash>`.
 * runId and fileHash are lowercase alphanumerics.
 */
export const RUN_SCHEMA = /^test_[a-z0-9]+(?:_[a-z0-9]+)?$/;

export type SchemaRow = { name: string; comment: string | null };

/**
 * Returns the names of `test_*` schemas whose comment holds an ISO timestamp strictly
 * older than 24h. Schemas without a parsable timestamp are never selected.
 */
export function selectStaleSchemas(rows: SchemaRow[], now: Date): string[] {
  return rows
    .filter((row) => {
      if (!RUN_SCHEMA.test(row.name) || !row.comment) return false;
      const created = Date.parse(row.comment);
      return Number.isFinite(created) && now.getTime() - created > STALE_AFTER_MS;
    })
    .map((row) => row.name);
}
