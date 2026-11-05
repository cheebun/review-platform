import { sql } from "drizzle-orm";
import { check, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { LOGIN_TOKEN_HASH_PREFIX } from "../../ports/login-token-store";

// Registered in `schema` (schema.ts) for the migration and `truncateAll`.
// No schema prefix: isolation comes from `search_path`.

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** The id of the single `login_token` row. */
export const LOGIN_TOKEN_ID = 1;

/**
 * The one login token, as its PBKDF2 hash (`pbkdf2-sha256$...`); never plaintext. A check
 * constraint pins the table to a single row, and another backs up the hash-only rule.
 */
export const loginToken = pgTable(
  "login_token",
  {
    id: smallint("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    createdAt: tstz("created_at").notNull(),
    rotatedAt: tstz("rotated_at"),
  },
  (t) => [
    check("login_token_singleton", sql`${t.id} = ${sql.raw(String(LOGIN_TOKEN_ID))}`),
    // `starts_with`, not LIKE: `$` and `_` need no escaping.
    check(
      "login_token_hash_check",
      sql`starts_with(${t.tokenHash}, ${sql.raw(`'${LOGIN_TOKEN_HASH_PREFIX}'`)})`,
    ),
  ],
);
