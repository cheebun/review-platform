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
import type { EncryptedToken } from "../../ports/token-cipher";
import { FakeTokenCipher } from "./fake-token-cipher";
import { InMemoryReviewEventRepo } from "./in-memory-review-event-repo";

type Row = { encrypted: EncryptedToken; meta: SecretMeta };
type ValueRow = { value: string | boolean; updatedAt: Date; updatedBy: string };
type State = {
  secrets: Map<SecretKind, Row>;
  channels: Map<string, StoredReviewChannel>;
  values: Map<SettingKey, ValueRow>;
};

/**
 * Fake ciphers, one `FakeTokenCipher` per kind. Ciphers of different `generation`s cannot read
 * each other's values (a different BETTER_AUTH_SECRET); `rotate()` moves to the next generation.
 */
export function fakeSecretCiphers(generation = 0): SecretCiphers & { rotate(): void } {
  const ciphers = new Map<SecretKind, FakeTokenCipher>();
  const cipherFor = (kind: SecretKind) => {
    let c = ciphers.get(kind);
    if (!c) {
      c = new FakeTokenCipher();
      for (let i = 0; i < generation; i++) c.rotate();
      ciphers.set(kind, c);
    }
    return c;
  };
  return Object.assign(cipherFor, {
    rotate: () => {
      for (const c of ciphers.values()) c.rotate();
    },
  });
}

const byNameThenId = (a: StoredReviewChannel, b: StoredReviewChannel) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.channelId < b.channelId ? -1 : 1;

/**
 * In-memory `SettingsStore`. Values are held encrypted with the injected ciphers, as in PG. Each
 * change and its event happen with no await in between, so the call is atomic (single-threaded
 * JS), as the PG transaction is; a failed event changes nothing. Pass the
 * `InMemoryReviewEventRepo` the rest of the test reads, as PG shares one database.
 */
export class InMemorySettingsStore implements SettingsStore {
  constructor(
    private readonly events: InMemoryReviewEventRepo = new InMemoryReviewEventRepo(),
    readonly ciphers: SecretCiphers = fakeSecretCiphers(),
    private readonly state: State = { secrets: new Map(), channels: new Map(), values: new Map() },
  ) {}

  /** A store over the same data with other keys (a rotated BETTER_AUTH_SECRET). */
  withCiphers(ciphers: SecretCiphers): InMemorySettingsStore {
    return new InMemorySettingsStore(this.events, ciphers, this.state);
  }

  async getSecret(kind: SecretKind): Promise<SecretRead> {
    const row = this.state.secrets.get(kind);
    if (!row) return { state: "not_configured" };
    const meta = structuredClone(row.meta);
    const plain = this.ciphers(kind).decrypt(row.encrypted);
    return plain.ok ? { state: "ready", value: plain.value, meta } : { state: "needs_reset", meta };
  }

  async saveSecret(
    kind: SecretKind,
    write: SecretWrite,
    event: (outcome: { replaced: boolean; meta: SecretMeta }) => NewReviewEvent,
  ): Promise<{ meta: SecretMeta; replaced: boolean }> {
    if (!write.value) throw new Error("saveSecret: empty value");
    const before = this.state.secrets.get(kind);
    const meta: SecretMeta = {
      kind,
      last4: write.value.slice(-4),
      savedAt: new Date(write.savedAt),
      savedByUserId: write.savedByUserId,
      verifiedAt: write.verifiedAt ? new Date(write.verifiedAt) : null,
      testResult: write.testResult ? structuredClone(write.testResult) : null,
      version: (before?.meta.version ?? 0) + 1,
    };
    const replaced = before !== undefined;
    const encrypted = this.ciphers(kind).encrypt(write.value);
    this.events.appendNow(event({ replaced, meta: structuredClone(meta) }));
    this.state.secrets.set(kind, { encrypted, meta });
    return { meta: structuredClone(meta), replaced };
  }

  async removeSecret(
    kind: SecretKind,
    event: (removed: SecretMeta) => NewReviewEvent,
  ): Promise<SecretMeta | null> {
    const row = this.state.secrets.get(kind);
    if (!row) return null;
    this.events.appendNow(event(structuredClone(row.meta)));
    this.state.secrets.delete(kind);
    return structuredClone(row.meta);
  }

  /**
   * Computes every change against the current state, builds the event, and only then applies
   * the writes, with no await in between: a refused bundle or a failed event changes nothing.
   */
  async saveBundle(
    bundle: SettingsBundle,
    options: SettingsBundleOptions,
  ): Promise<SettingsBundleOutcome> {
    const parsed = parseSettingsBundle(bundle);
    const secretRows: [SecretKind, Row][] = [];
    const outcome: SettingsBundleOutcome = {
      savedSecrets: [],
      changedValues: [],
      removedSecrets: [],
      removedValues: [],
    };
    for (const [kind, write] of parsed.secrets) {
      const before = this.state.secrets.get(kind);
      const meta: SecretMeta = {
        kind,
        last4: write.value.slice(-4),
        savedAt: new Date(write.savedAt),
        savedByUserId: write.savedByUserId,
        verifiedAt: write.verifiedAt ? new Date(write.verifiedAt) : null,
        testResult: write.testResult ? structuredClone(write.testResult) : null,
        version: (before?.meta.version ?? 0) + 1,
      };
      secretRows.push([kind, { encrypted: this.ciphers(kind).encrypt(write.value), meta }]);
      outcome.savedSecrets.push({ kind, meta: structuredClone(meta), replaced: !!before });
    }
    const valueWrites = parsed.values.filter(
      ([key, value]) => this.state.values.get(key)?.value !== value,
    );
    outcome.changedValues = valueWrites.map(([key]) => key);
    for (const kind of parsed.removeSecrets) {
      const row = this.state.secrets.get(kind);
      if (row) outcome.removedSecrets.push(structuredClone(row.meta));
    }
    outcome.removedValues = parsed.removeValues.filter((key) => this.state.values.has(key));
    if (!bundleChanged(outcome)) return outcome;

    this.events.appendNow(options.event(structuredClone(outcome)));
    for (const [kind, row] of secretRows) this.state.secrets.set(kind, row);
    for (const meta of outcome.removedSecrets) this.state.secrets.delete(meta.kind);
    for (const [key, value] of valueWrites) {
      this.state.values.set(key, {
        value,
        updatedAt: new Date(options.at),
        updatedBy: options.by,
      });
    }
    for (const key of outcome.removedValues) this.state.values.delete(key);
    return structuredClone(outcome);
  }

  async markSecretVerified(kind: SecretKind, version: number, at: Date): Promise<boolean> {
    const row = this.state.secrets.get(kind);
    if (!row || row.meta.version !== version) return false;
    row.meta = { ...row.meta, verifiedAt: new Date(at) };
    return true;
  }

  async getValues<K extends SettingKey>(
    keys: readonly K[],
  ): Promise<Partial<Pick<SettingValues, K>>> {
    const out: Partial<Record<SettingKey, string | boolean>> = {};
    for (const key of parseSettingKeys(keys)) {
      const row = this.state.values.get(key);
      if (row) out[key] = row.value;
    }
    return out as Partial<Pick<SettingValues, K>>;
  }

  async saveValues(
    values: Partial<SettingValues>,
    options: { at: Date; by: string; event: (change: { changed: SettingKey[] }) => NewReviewEvent },
  ): Promise<{ changed: SettingKey[] }> {
    const entries = parseSettingValues(values).filter(
      ([key, value]) => this.state.values.get(key)?.value !== value,
    );
    const changed = entries.map(([key]) => key);
    if (changed.length === 0) return { changed };
    this.events.appendNow(options.event({ changed: [...changed] }));
    for (const [key, value] of entries) {
      this.state.values.set(key, { value, updatedAt: new Date(options.at), updatedBy: options.by });
    }
    return { changed };
  }

  async removeValues(
    keys: readonly SettingKey[],
    options: { event: (change: { removed: SettingKey[] }) => NewReviewEvent },
  ): Promise<{ removed: SettingKey[] }> {
    const removed = parseSettingKeys(keys).filter((key) => this.state.values.has(key));
    if (removed.length === 0) return { removed };
    this.events.appendNow(options.event({ removed: [...removed] }));
    for (const key of removed) this.state.values.delete(key);
    return { removed };
  }

  async listReviewChannels(): Promise<StoredReviewChannel[]> {
    return [...this.state.channels.values()].toSorted(byNameThenId).map((c) => structuredClone(c));
  }

  async setReviewChannels(
    channels: ReviewChannelInput[],
    options: { at: Date; by: string; event: (diff: ReviewChannelDiff) => NewReviewEvent },
  ): Promise<{ channels: StoredReviewChannel[]; diff: ReviewChannelDiff }> {
    const ids = new Set(channels.map((c) => c.channelId));
    if (ids.size !== channels.length) throw new Error("setReviewChannels: duplicate channel id");
    const current = this.state.channels;
    const diff: ReviewChannelDiff = {
      added: [...ids].filter((id) => !current.has(id)).toSorted(),
      removed: [...current.keys()].filter((id) => !ids.has(id)).toSorted(),
    };
    const next = new Map<string, StoredReviewChannel>();
    for (const c of channels) {
      const kept = current.get(c.channelId);
      next.set(c.channelId, {
        channelId: c.channelId,
        name: c.name,
        missing: c.missing,
        checkedAt: c.checkedAt ? new Date(c.checkedAt) : null,
        addedAt: kept ? kept.addedAt : new Date(options.at),
        addedBy: kept ? kept.addedBy : options.by,
      });
    }
    if (diff.added.length > 0 || diff.removed.length > 0) {
      this.events.appendNow(options.event(structuredClone(diff)));
    }
    this.state.channels = next;
    return { channels: await this.listReviewChannels(), diff };
  }

  async updateReviewChannelChecks(
    checks: Pick<StoredReviewChannel, "channelId" | "name" | "missing">[],
    at: Date,
  ): Promise<void> {
    for (const check of checks) {
      const c = this.state.channels.get(check.channelId);
      if (!c) continue;
      this.state.channels.set(check.channelId, {
        ...c,
        name: check.name,
        missing: check.missing,
        checkedAt: new Date(at),
      });
    }
  }

  /** Test helper: what the "database" holds, for plaintext substring checks. */
  dump(): string {
    return JSON.stringify({
      secrets: [...this.state.secrets.entries()],
      channels: [...this.state.channels.entries()],
      values: [...this.state.values.entries()],
    });
  }
}
