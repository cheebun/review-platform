import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteDb, migrate, MIGRATIONS_FOLDER, type PgliteHandle } from "./client";
import { PgReviewJobRepo } from "./pg-review-job-repo";
import { FakeClock } from "../../testing/fakes/fake-clock";

// The migration that removes the `reaction_pending` state (stage 3w).
const MIGRATION = "20261104061836_review_tables";

let handle: PgliteHandle;
let before: string;

const insertJob = (id: string, state: string, extra = "NULL, NULL, NULL") =>
  handle.client.query(
    `INSERT INTO review_job (id, source, state, urls, progress, attempts, next_attempt_at,
       lease_owner, lease_until, github_account, version, created_at, updated_at)
     VALUES ($1, 'slack', $2, '[]', '{}', 1, ${extra}, 'acme-bot', 3,
       '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
    [id, state],
  );

beforeAll(async () => {
  // Every migration before MIGRATION, copied to a scratch folder, then the real folder.
  before = await mkdtemp(join(tmpdir(), "migrations-"));
  const entries = await readdir(MIGRATIONS_FOLDER, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  expect(dirs).toContain(MIGRATION);
  for (const name of dirs.filter((d) => d < MIGRATION)) {
    await cp(join(MIGRATIONS_FOLDER, name), join(before, name), { recursive: true });
  }
  handle = await createPgliteDb();
  await migrate(handle.db, { migrationsFolder: before });
  await insertJob("pending-reaction", "reaction_pending", "'2026-01-03T00:00:00Z', NULL, NULL");
  await insertJob("queued", "queued");
  await insertJob("done", "done");
  await insertJob("running", "running", "NULL, 'w1', '2026-01-02T01:00:00Z'");
  await migrate(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
  if (before) await rm(before, { recursive: true, force: true });
});

describe(`migration ${MIGRATION}`, () => {
  it("turns reaction_pending jobs into done ones: their review already finished", async () => {
    const job = await new PgReviewJobRepo(handle.db, new FakeClock()).get("pending-reaction");
    expect(job).toMatchObject({
      state: "done",
      nextAttemptAt: null,
      leaseOwner: null,
      leaseUntil: null,
      // A worker still holding the old version is fenced out by the CAS.
      version: 4,
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    expect(job).not.toHaveProperty("runStartedAt");
  });

  it("leaves no reaction_pending row and every other job untouched", async () => {
    const { rows } = await handle.client.query<{ id: string; state: string; version: number }>(
      "SELECT id, state, version FROM review_job ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "done", state: "done", version: 3 },
      { id: "pending-reaction", state: "done", version: 4 },
      { id: "queued", state: "queued", version: 3 },
      { id: "running", state: "running", version: 3 },
    ]);
  });

  it("creates the stage 3d tables", async () => {
    const { rows } = await handle.client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('review_result', 'slack_review_thread', 'slack_reaction', 'reaction_outbox')
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "reaction_outbox",
      "review_result",
      "slack_reaction",
      "slack_review_thread",
    ]);
  });
});
