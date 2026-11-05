import { getTableName, sql } from "drizzle-orm";
import type { Db } from "./client";
import { schema } from "./schema";

/**
 * Test helper: empties every table in the connection's search_path schema and restarts identity
 * columns (`reaction_outbox.id`), so every test sees the same ids.
 */
export async function truncateAll(db: Db): Promise<void> {
  const tables = Object.values(schema).map((t) => sql.identifier(getTableName(t)));
  await db.execute(sql`TRUNCATE TABLE ${sql.join(tables, sql`, `)} RESTART IDENTITY`);
}
