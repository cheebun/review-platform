import { sql } from "drizzle-orm";
import { migrate, type Db } from "./client";

export const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Applies `drizzle/` into `schema`: creates it if missing, points the session's `search_path` at
 * it so tables land there, and keeps the migration journal in the same schema. Needs a
 * single-connection handle (`max: 1`), because `search_path` is per session.
 */
export async function migrateIntoSchema(
  db: Db,
  schema: string,
  opts: { migrationsFolder?: string } = {},
): Promise<void> {
  if (!SCHEMA_NAME.test(schema))
    throw new Error("invalid schema name: must match ^[a-z_][a-z0-9_]*$");
  // `schema` is validated above, so quoting it is safe.
  await db.execute(sql.raw(`create schema if not exists "${schema}"`));
  await db.execute(sql.raw(`set search_path to "${schema}"`));
  await migrate(db, { ...opts, migrationsSchema: schema });
}
