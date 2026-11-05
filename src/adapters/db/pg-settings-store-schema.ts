import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  SECRET_KINDS,
  SETTING_KEYS,
  SETTING_VALUE_MAX_LENGTH,
  type SecretKind,
  type SecretTestResult,
  type SettingKey,
} from "../../ports/settings-store";

// Owned by 3j; registered in `schema` (schema.ts) for the migration and `truncateAll`.
// No schema prefix: isolation comes from `search_path`.

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `'a', 'b', ...` of compile-time constants: safe to inline in a CHECK constraint. */
const kindList = sql.raw(SECRET_KINDS.map((k) => `'${k}'`).join(", "));

/** `'a', 'b', ...` of the setting keys, compile-time constants as well. */
const settingKeyList = sql.raw(SETTING_KEYS.map((k) => `'${k}'`).join(", "));

/**
 * Every settings secret except the GitHub token, one row per kind (FR-SLACKCFG-02,
 * FR-SETTINGS-01). AES-256-GCM ciphertext only, keyed per kind; never plaintext.
 */
export const settingSecret = pgTable(
  "setting_secret",
  {
    kind: text("kind").$type<SecretKind>().primaryKey(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    last4: text("last4").notNull(),
    savedAt: tstz("saved_at").notNull(),
    savedByUserId: text("saved_by_user_id").notNull(),
    verifiedAt: tstz("verified_at"),
    /** Non-secret facts from the last connection test (workspace and user name). */
    testResult: jsonb("test_result").$type<SecretTestResult>(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check("setting_secret_kind_check", sql`${t.kind} IN (${kindList})`),
    check("setting_secret_version_check", sql`${t.version} >= 1`),
  ],
);

/** The selected Slack review channels (FR-SLACKCFG-04). Empty = all channels; DMs always count. */
export const slackReviewChannel = pgTable(
  "slack_review_channel",
  {
    channelId: text("channel_id").primaryKey(),
    /** Cached for display. */
    name: text("name").notNull(),
    /** Deleted, archived or left: flagged in place. */
    missing: boolean("missing").notNull().default(false),
    checkedAt: tstz("checked_at"),
    addedAt: tstz("added_at").notNull(),
    addedBy: text("added_by").notNull(),
  },
  (t) => [
    index("slack_review_channel_name_idx").on(t.name, t.channelId),
    check("slack_review_channel_id_check", sql`${t.channelId} ~ '^[CG][A-Z0-9]+$'`),
  ],
);

/**
 * Non-secret settings, one row per key (FR-SETTINGS-01, FR-JIRACFG-01, FR-LLMCFG-01): a JSON
 * string or boolean. Never a secret: those are in `setting_secret`. The store checks types and
 * lengths first; the constraints back it up.
 */
export const settingValue = pgTable(
  "setting_value",
  {
    key: text("key").$type<SettingKey>().primaryKey(),
    value: jsonb("value").$type<string | boolean>().notNull(),
    updatedAt: tstz("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    check("setting_value_key_check", sql`${t.key} IN (${settingKeyList})`),
    check(
      "setting_value_value_check",
      sql`jsonb_typeof(${t.value}) = 'boolean' OR (jsonb_typeof(${t.value}) = 'string' AND length(${t.value} #>> '{}') BETWEEN 1 AND ${sql.raw(String(SETTING_VALUE_MAX_LENGTH))})`,
    ),
  ],
);
