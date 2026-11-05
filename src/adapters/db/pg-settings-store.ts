import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import {
  bundleChanged,
  parseSettingKeys,
  parseSettingsBundle,
  parseSettingValues,
  type ReviewChannelDiff,
  type ReviewChannelInput,
  type SecretCiphers,
  type SecretKind,
  type SecretMeta,
  type SecretRead,
  type SecretWrite,
  type SettingKey,
  type SettingsBundle,
  type SettingsBundleOptions,
  type SettingsBundleOutcome,
  type SettingsStore,
  type SettingValues,
  type StoredReviewChannel,
} from "../../ports/settings-store";
import type { Db } from "./client";
import { insertReviewEvent } from "./pg-review-event-repo";
import { settingSecret, settingValue, slackReviewChannel } from "./pg-settings-store-schema";

type SecretRow = typeof settingSecret.$inferSelect;
type ChannelRow = typeof slackReviewChannel.$inferSelect;

const toMeta = (row: SecretRow): SecretMeta => ({
  kind: row.kind,
  last4: row.last4,
  savedAt: row.savedAt,
  savedByUserId: row.savedByUserId,
  verifiedAt: row.verifiedAt ?? null,
  testResult: row.testResult ? structuredClone(row.testResult) : null,
  version: row.version,
});

const toChannel = (row: ChannelRow): StoredReviewChannel => ({
  channelId: row.channelId,
  name: row.name,
  missing: row.missing,
  checkedAt: row.checkedAt ?? null,
  addedAt: row.addedAt,
  addedBy: row.addedBy,
});

/**
 * `setting_secret`, `setting_value` and `slack_review_channel`. Secrets are encrypted here with the kind's cipher
 * before they reach SQL, and decrypted on read; a decrypt failure is `needs_reset`. Plaintext is
 * never logged, and errors never carry it (it is only ever a cipher input).
 */
export class PgSettingsStore implements SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly ciphers: SecretCiphers,
  ) {}

  async getSecret(kind: SecretKind): Promise<SecretRead> {
    const [row] = await this.db.select().from(settingSecret).where(eq(settingSecret.kind, kind));
    if (!row) return { state: "not_configured" };
    const meta = toMeta(row);
    const plain = this.ciphers(kind).decrypt({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
    });
    return plain.ok ? { state: "ready", value: plain.value, meta } : { state: "needs_reset", meta };
  }

  /**
   * Upsert, then the event, in one transaction. The upsert's row lock serialises concurrent saves
   * of a kind until commit, and the version tells an insert (1, also after a removal) from a
   * replacement.
   */
  async saveSecret(
    kind: SecretKind,
    write: SecretWrite,
    event: (outcome: { replaced: boolean; meta: SecretMeta }) => NewReviewEvent,
  ): Promise<{ meta: SecretMeta; replaced: boolean }> {
    if (!write.value) throw new Error("saveSecret: empty value");
    const encrypted = this.ciphers(kind).encrypt(write.value);
    const values = {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyVersion: encrypted.keyVersion,
      last4: write.value.slice(-4),
      savedAt: write.savedAt,
      savedByUserId: write.savedByUserId,
      verifiedAt: write.verifiedAt,
      testResult: write.testResult,
    };
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(settingSecret)
        .values({ kind, ...values, version: 1 })
        .onConflictDoUpdate({
          target: settingSecret.kind,
          set: { ...values, version: sql`${settingSecret.version} + 1` },
        })
        .returning();
      const meta = toMeta(row);
      const replaced = row.version > 1;
      await insertReviewEvent(tx, event({ replaced, meta: structuredClone(meta) }));
      return { meta, replaced };
    });
  }

  async removeSecret(
    kind: SecretKind,
    event: (removed: SecretMeta) => NewReviewEvent,
  ): Promise<SecretMeta | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.delete(settingSecret).where(eq(settingSecret.kind, kind)).returning();
      if (!row) return null;
      const meta = toMeta(row);
      await insertReviewEvent(tx, event(structuredClone(meta)));
      return meta;
    });
  }

  /**
   * One transaction: both tables are locked (always `setting_secret` first, then
   * `setting_value`) in a mode that conflicts with itself and with every other writer, so
   * concurrent bundles and single saves are serialised and the outcome is computed against
   * committed state. The event is inserted last; if it (or its builder) fails, every write of
   * the bundle rolls back. Readers are not blocked.
   */
  async saveBundle(
    bundle: SettingsBundle,
    options: SettingsBundleOptions,
  ): Promise<SettingsBundleOutcome> {
    const parsed = parseSettingsBundle(bundle);
    // Encrypt before the transaction: no CPU work and no plaintext inside it.
    const encrypted = parsed.secrets.map(([kind, write]) => {
      const e = this.ciphers(kind).encrypt(write.value);
      return {
        kind,
        values: {
          ciphertext: e.ciphertext,
          iv: e.iv,
          authTag: e.authTag,
          keyVersion: e.keyVersion,
          last4: write.value.slice(-4),
          savedAt: write.savedAt,
          savedByUserId: write.savedByUserId,
          verifiedAt: write.verifiedAt,
          testResult: write.testResult,
        },
      };
    });
    const empty = (): SettingsBundleOutcome => ({
      savedSecrets: [],
      changedValues: [],
      removedSecrets: [],
      removedValues: [],
    });
    const touchesSecrets = parsed.secrets.length > 0 || parsed.removeSecrets.length > 0;
    const touchesValues = parsed.values.length > 0 || parsed.removeValues.length > 0;
    if (!touchesSecrets && !touchesValues) return empty();

    return this.db.transaction(async (tx) => {
      if (touchesSecrets) {
        await tx.execute(sql`LOCK TABLE ${settingSecret} IN SHARE ROW EXCLUSIVE MODE`);
      }
      if (touchesValues) {
        await tx.execute(sql`LOCK TABLE ${settingValue} IN SHARE ROW EXCLUSIVE MODE`);
      }
      const outcome = empty();

      for (const { kind, values } of encrypted) {
        const [row] = await tx
          .insert(settingSecret)
          .values({ kind, ...values, version: 1 })
          .onConflictDoUpdate({
            target: settingSecret.kind,
            set: { ...values, version: sql`${settingSecret.version} + 1` },
          })
          .returning();
        outcome.savedSecrets.push({ kind, meta: toMeta(row), replaced: row.version > 1 });
      }
      if (parsed.removeSecrets.length > 0) {
        const rows = await tx
          .delete(settingSecret)
          .where(inArray(settingSecret.kind, parsed.removeSecrets))
          .returning();
        const byKind = new Map(rows.map((r) => [r.kind, r]));
        for (const kind of parsed.removeSecrets) {
          const row = byKind.get(kind);
          if (row) outcome.removedSecrets.push(toMeta(row));
        }
      }

      if (parsed.values.length > 0) {
        const current = await tx
          .select({ key: settingValue.key, value: settingValue.value })
          .from(settingValue)
          .where(
            inArray(
              settingValue.key,
              parsed.values.map(([key]) => key),
            ),
          );
        const before = new Map(current.map((r) => [r.key, r.value]));
        const writes = parsed.values.filter(([key, value]) => before.get(key) !== value);
        outcome.changedValues = writes.map(([key]) => key);
        if (writes.length > 0) {
          await tx
            .insert(settingValue)
            .values(
              writes.map(([key, value]) => ({
                key,
                value,
                updatedAt: options.at,
                updatedBy: options.by,
              })),
            )
            .onConflictDoUpdate({
              target: settingValue.key,
              set: {
                value: sql`excluded.value`,
                updatedAt: sql`excluded.updated_at`,
                updatedBy: sql`excluded.updated_by`,
              },
            });
        }
      }
      if (parsed.removeValues.length > 0) {
        const rows = await tx
          .delete(settingValue)
          .where(inArray(settingValue.key, parsed.removeValues))
          .returning({ key: settingValue.key });
        const gone = new Set(rows.map((r) => r.key));
        outcome.removedValues = parsed.removeValues.filter((key) => gone.has(key));
      }

      if (!bundleChanged(outcome)) return outcome;
      await insertReviewEvent(tx, options.event(structuredClone(outcome)));
      return outcome;
    });
  }

  async markSecretVerified(kind: SecretKind, version: number, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(settingSecret)
      .set({ verifiedAt: at })
      .where(and(eq(settingSecret.kind, kind), eq(settingSecret.version, version)))
      .returning({ kind: settingSecret.kind });
    return rows.length > 0;
  }

  async getValues<K extends SettingKey>(
    keys: readonly K[],
  ): Promise<Partial<Pick<SettingValues, K>>> {
    const wanted = parseSettingKeys(keys);
    if (wanted.length === 0) return {};
    const rows = await this.db
      .select({ key: settingValue.key, value: settingValue.value })
      .from(settingValue)
      .where(inArray(settingValue.key, wanted));
    const out: Partial<Record<SettingKey, string | boolean>> = {};
    for (const row of rows) out[row.key] = row.value;
    return out as Partial<Pick<SettingValues, K>>;
  }

  /**
   * Read, upsert the changed keys and the event under a table lock that conflicts with itself, so
   * concurrent writes are serialised and `changed` is computed against committed state, including
   * keys that have no row yet. Readers are not blocked.
   */
  async saveValues(
    values: Partial<SettingValues>,
    options: { at: Date; by: string; event: (change: { changed: SettingKey[] }) => NewReviewEvent },
  ): Promise<{ changed: SettingKey[] }> {
    const entries = parseSettingValues(values);
    if (entries.length === 0) return { changed: [] };
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${settingValue} IN SHARE ROW EXCLUSIVE MODE`);
      const current = await tx
        .select({ key: settingValue.key, value: settingValue.value })
        .from(settingValue)
        .where(
          inArray(
            settingValue.key,
            entries.map(([key]) => key),
          ),
        );
      const before = new Map(current.map((r) => [r.key, r.value]));
      const writes = entries.filter(([key, value]) => before.get(key) !== value);
      const changed = writes.map(([key]) => key);
      if (changed.length === 0) return { changed };
      await tx
        .insert(settingValue)
        .values(
          writes.map(([key, value]) => ({
            key,
            value,
            updatedAt: options.at,
            updatedBy: options.by,
          })),
        )
        .onConflictDoUpdate({
          target: settingValue.key,
          set: {
            value: sql`excluded.value`,
            updatedAt: sql`excluded.updated_at`,
            updatedBy: sql`excluded.updated_by`,
          },
        });
      await insertReviewEvent(tx, options.event({ changed: [...changed] }));
      return { changed };
    });
  }

  /** Same lock as `saveValues`, so concurrent removes report each key once. */
  async removeValues(
    keys: readonly SettingKey[],
    options: { event: (change: { removed: SettingKey[] }) => NewReviewEvent },
  ): Promise<{ removed: SettingKey[] }> {
    const wanted = parseSettingKeys(keys);
    if (wanted.length === 0) return { removed: [] };
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${settingValue} IN SHARE ROW EXCLUSIVE MODE`);
      const rows = await tx
        .delete(settingValue)
        .where(inArray(settingValue.key, wanted))
        .returning({ key: settingValue.key });
      const gone = new Set(rows.map((r) => r.key));
      const removed = wanted.filter((key) => gone.has(key));
      if (removed.length === 0) return { removed };
      await insertReviewEvent(tx, options.event({ removed: [...removed] }));
      return { removed };
    });
  }

  async listReviewChannels(): Promise<StoredReviewChannel[]> {
    const rows = await this.db
      .select()
      .from(slackReviewChannel)
      .orderBy(asc(slackReviewChannel.name), asc(slackReviewChannel.channelId));
    return rows.map(toChannel);
  }

  /**
   * Diff, delete, upsert and the event under a table lock that conflicts with itself, so
   * concurrent replacements are serialised and each diff is computed against committed state.
   * Readers are not blocked.
   */
  async setReviewChannels(
    channels: ReviewChannelInput[],
    options: { at: Date; by: string; event: (diff: ReviewChannelDiff) => NewReviewEvent },
  ): Promise<{ channels: StoredReviewChannel[]; diff: ReviewChannelDiff }> {
    const ids = channels.map((c) => c.channelId);
    if (new Set(ids).size !== ids.length) {
      throw new Error("setReviewChannels: duplicate channel id");
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${slackReviewChannel} IN SHARE ROW EXCLUSIVE MODE`);
      const current = await tx
        .select({ channelId: slackReviewChannel.channelId })
        .from(slackReviewChannel);
      const before = new Set(current.map((c) => c.channelId));
      const wanted = new Set(ids);
      const diff: ReviewChannelDiff = {
        added: ids.filter((id) => !before.has(id)).toSorted(),
        removed: [...before].filter((id) => !wanted.has(id)).toSorted(),
      };
      if (ids.length === 0) {
        await tx.delete(slackReviewChannel);
      } else {
        await tx.delete(slackReviewChannel).where(notInArray(slackReviewChannel.channelId, ids));
        await tx
          .insert(slackReviewChannel)
          .values(
            channels.map((c) => ({
              channelId: c.channelId,
              name: c.name,
              missing: c.missing,
              checkedAt: c.checkedAt,
              addedAt: options.at,
              addedBy: options.by,
            })),
          )
          .onConflictDoUpdate({
            target: slackReviewChannel.channelId,
            // Kept channels keep added_at and added_by.
            set: {
              name: sql`excluded.name`,
              missing: sql`excluded.missing`,
              checkedAt: sql`excluded.checked_at`,
            },
          });
      }
      if (diff.added.length > 0 || diff.removed.length > 0) {
        await insertReviewEvent(tx, options.event(structuredClone(diff)));
      }
      const rows = await tx
        .select()
        .from(slackReviewChannel)
        .orderBy(asc(slackReviewChannel.name), asc(slackReviewChannel.channelId));
      return { channels: rows.map(toChannel), diff };
    });
  }

  async updateReviewChannelChecks(
    checks: Pick<StoredReviewChannel, "channelId" | "name" | "missing">[],
    at: Date,
  ): Promise<void> {
    if (checks.length === 0) return;
    // An id that is not selected matches no row and is ignored.
    await this.db.transaction(async (tx) => {
      for (const check of checks) {
        await tx
          .update(slackReviewChannel)
          .set({ name: check.name, missing: check.missing, checkedAt: at })
          .where(eq(slackReviewChannel.channelId, check.channelId));
      }
    });
  }
}
