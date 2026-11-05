import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { aSettingsEvent } from "../../testing/contracts/harness";
import { settingsStoreContract } from "../../testing/contracts/settings-store.contract";
import { createSecretCiphers } from "../crypto/aes-gcm-token-cipher";
import type { SettingsStore } from "../../ports/settings-store";
import { PgReviewEventRepo } from "./pg-review-event-repo";
import { PgSettingsStore } from "./pg-settings-store";
import { pgliteFixture } from "./pglite-fixture";

// Fake secrets: test vectors only.
const SECRET = "test-secret-0123456789abcdefghijklmnop";
const ROTATED = "rotated-secret-0123456789abcdefghijkl";
const VALUE = "xoxp-0000-FAKE-db-test-SENTINEL-value-9f3c";

const fixture = pgliteFixture();

const store = (secret = SECRET): SettingsStore =>
  new PgSettingsStore(fixture.db(), createSecretCiphers({ secret }));

settingsStoreContract(async () => ({
  impl: store(),
  events: new PgReviewEventRepo(fixture.db()),
  rotated: () => store(ROTATED),
  advance: async () => {},
  cleanup: async () => {},
}));

describe("PgSettingsStore (PG specifics)", () => {
  it("stores only ciphertext, with the kind's own key", async () => {
    await store().saveSecret(
      "slack_user_token",
      {
        value: VALUE,
        savedAt: new Date("2026-11-04T03:00:00.000Z"),
        savedByUserId: "owner-1",
        verifiedAt: null,
        testResult: null,
      },
      () => aSettingsEvent("slack_secret_saved"),
    );
    const rows = (await fixture.db().execute(sql`SELECT * FROM setting_secret`)) as unknown as
      | Record<string, unknown>[]
      | { rows: Record<string, unknown>[] };
    const list = Array.isArray(rows) ? rows : rows.rows;
    expect(list).toHaveLength(1);
    const raw = JSON.stringify(list);
    expect(raw).not.toContain(VALUE);
    expect(raw).not.toContain(VALUE.slice(0, -4));
    expect(raw).not.toContain(Buffer.from(VALUE).toString("base64").slice(0, 20));
    expect(list[0]).toMatchObject({ kind: "slack_user_token", key_version: 1, last4: "9f3c" });
    const enc = {
      ciphertext: String(list[0].ciphertext),
      iv: String(list[0].iv),
      authTag: String(list[0].auth_tag),
      keyVersion: 1,
    };
    const ciphers = createSecretCiphers({ secret: SECRET });
    expect(ciphers("slack_user_token").decrypt(enc)).toEqual({ ok: true, value: VALUE });
    expect(ciphers("slack_app_token").decrypt(enc)).toEqual({ ok: false, error: "needs_reset" });
  });

  it("rejects an unknown kind and a malformed channel id at the table", async () => {
    await expect(
      fixture
        .db()
        .execute(
          sql`INSERT INTO setting_secret (kind, ciphertext, iv, auth_tag, key_version, last4, saved_at, saved_by_user_id) VALUES ('github', 'x', 'x', 'x', 1, 'x', now(), 'u')`,
        ),
    ).rejects.toThrow();
    await expect(
      fixture
        .db()
        .execute(
          sql`INSERT INTO slack_review_channel (channel_id, name, added_at, added_by) VALUES ('D0AAA', 'dm', now(), 'u')`,
        ),
    ).rejects.toThrow();
  });

  it("stores values as JSON strings and booleans, with who and when", async () => {
    const at = new Date("2026-11-04T08:00:00.000Z");
    await store().saveValues(
      { jira_email: "owner@example.com", anthropic_server_fallback: false },
      { at, by: "owner-1", event: () => aSettingsEvent("slack_channels_changed") },
    );
    const rows = (await fixture
      .db()
      .execute(
        sql`SELECT key, jsonb_typeof(value) AS type, value #>> '{}' AS text, updated_at, updated_by FROM setting_value ORDER BY key`,
      )) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
    const list = Array.isArray(rows) ? rows : rows.rows;
    expect(list.map((r) => ({ ...r, updated_at: undefined }))).toEqual([
      {
        key: "anthropic_server_fallback",
        type: "boolean",
        text: "false",
        updated_at: undefined,
        updated_by: "owner-1",
      },
      {
        key: "jira_email",
        type: "string",
        text: "owner@example.com",
        updated_at: undefined,
        updated_by: "owner-1",
      },
    ]);
    expect(new Date(String(list[0].updated_at)).getTime()).toBe(at.getTime());
  });

  it("rejects an unknown key, a non-scalar, an empty or an over-long value at the table", async () => {
    const insert = (key: string, value: string) =>
      fixture
        .db()
        .execute(
          sql`INSERT INTO setting_value (key, value, updated_at, updated_by) VALUES (${key}, ${value}::jsonb, now(), 'u')`,
        );
    await expect(insert("jira_api_token", '"x"')).rejects.toThrow();
    await expect(insert("jira_email", "5")).rejects.toThrow();
    await expect(insert("jira_email", '{"a":1}')).rejects.toThrow();
    await expect(insert("jira_email", '""')).rejects.toThrow();
    await expect(insert("jira_email", JSON.stringify("x".repeat(2049)))).rejects.toThrow();
    await insert("jira_email", JSON.stringify("x".repeat(2048)));
  });
});
