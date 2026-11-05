import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteDb, type PgliteHandle } from "./client";
import { migrateIntoSchema } from "./migrate-schema";

let handle: PgliteHandle;
beforeAll(async () => {
  handle = await createPgliteDb();
}, 60_000);
afterAll(async () => {
  await handle.close();
});

const tables = async (schema: string): Promise<string[]> => {
  const res = await handle.client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = $1 order by 1",
    [schema],
  );
  return res.rows.map((r) => r.table_name);
};

describe("migrateIntoSchema", () => {
  it("creates the schema and puts tables and the journal in it, nothing in public/drizzle", async () => {
    await migrateIntoSchema(handle.db, "dev");
    const dev = await tables("dev");
    expect(dev).toContain("app_state");
    expect(dev).toContain("__drizzle_migrations");
    expect(await tables("public")).toEqual([]);
    expect(await tables("drizzle")).toEqual([]);
  }, 60_000);

  it("is idempotent", async () => {
    await expect(migrateIntoSchema(handle.db, "dev")).resolves.toBeUndefined();
  }, 60_000);

  it("rejects an unsafe schema name before touching the database", async () => {
    await expect(migrateIntoSchema(handle.db, 'x"; drop schema dev; --')).rejects.toThrow(
      /schema/i,
    );
    expect(await tables("dev")).toContain("app_state");
  });
});
