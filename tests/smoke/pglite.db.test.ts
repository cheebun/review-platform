import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, expect, it } from "vitest";

const widget = pgTable("widget", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
});

const client = new PGlite();
const db = drizzle({ client });
afterAll(() => client.close());

it("drizzle 1.0 RC creates a table, inserts and selects on PGlite", async () => {
  await db.execute(
    "create table widget (id integer primary key generated always as identity, name text not null)",
  );
  await db.insert(widget).values({ name: "gear" });
  const rows = await db.select().from(widget).where(eq(widget.name, "gear"));
  expect(rows).toEqual([{ id: 1, name: "gear" }]);
});
