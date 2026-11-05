import postgres from "postgres";
import { afterAll, expect, inject, it } from "vitest";
import { testPgUrl } from "../../src/testing/integration/urls";

const sql = postgres(testPgUrl(), { ssl: "require", max: 1, connect_timeout: 20 });
afterAll(() => sql.end({ timeout: 5 }));

it("connects to the remote PostgreSQL over TLS and runs select 1", async () => {
  const [row] = await sql`select 1 as one`;
  expect(row.one).toBe(1);
});

it("the run schema exists and carries a timestamp comment", async () => {
  const schema = inject("schema");
  expect(schema).toMatch(/^test_[a-z0-9]+$/);
  const [row] = await sql`
    select obj_description(n.oid, 'pg_namespace') as comment
    from pg_namespace n where n.nspname = ${schema}`;
  expect(Number.isFinite(Date.parse(row.comment))).toBe(true);
});
