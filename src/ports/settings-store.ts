import type { NewReviewEvent } from "./review-event-repo";
import type { TokenCipher } from "./token-cipher";

/**
 * Every settings secret except the GitHub token, declared up front so later sections never edit
 * this port (migration-plan.md 1b). The GitHub token stays in `CredentialStore`
 * (`github_credential`) and is not migrated.
 */
export const SECRET_KINDS = [
  "slack_user_token",
  "slack_signing_secret",
  // Retained only for encrypted historical rows; no active feature reads this secret.
  "slack_app_token",
  // Retained for encrypted historical rows; no active Jira feature reads this secret.
  "jira_api_token",
  "anthropic_api_key",
  "anthropic_auth_token",
  "openai_api_key",
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

export const isSecretKind = (value: unknown): value is SecretKind =>
  typeof value === "string" && (SECRET_KINDS as readonly string[]).includes(value);

/**
 * The HKDF purpose of a kind: the key is derived with salt and info
 * `agent-ops:<purpose>:v<keyVersion>`, e.g. `agent-ops:slack-user-token:v1` (FR-SLACKCFG-02).
 */
export const secretKeyPurpose = (kind: SecretKind): string => kind.replaceAll("_", "-");

/** Picks the cipher of a kind; each kind has its own key (`createSecretCiphers`). */
export type SecretCiphers = (kind: SecretKind) => TokenCipher;

/** Small, non-secret facts from the last connection test (workspace name, user name). */
export type SecretTestResult = Record<string, string | number | boolean | null>;

/** Everything stored next to the ciphertext. Never contains the secret. */
export type SecretMeta = {
  kind: SecretKind;
  last4: string;
  savedAt: Date;
  savedByUserId: string;
  /** When a check last confirmed the secret works; null means unverified (⚠ 未验证). */
  verifiedAt: Date | null;
  testResult: SecretTestResult | null;
  /** Bumped on every save of this kind; lets `markSecretVerified` skip a replaced secret. */
  version: number;
};

/**
 * A secret as the server reads it. `needs_reset`: a row exists but cannot be decrypted (rotated
 * `BETTER_AUTH_SECRET`, tampering), FR-SETTINGS-01.
 */
export type SecretRead =
  | { state: "not_configured" }
  | { state: "needs_reset"; meta: SecretMeta }
  | { state: "ready"; value: string; meta: SecretMeta };

export type SecretWrite = {
  /** The plaintext. The store encrypts it; it is never stored, logged or returned. */
  value: string;
  savedAt: Date;
  savedByUserId: string;
  verifiedAt: Date | null;
  testResult: SecretTestResult | null;
};

/** One selected review channel (`slack_review_channel`, FR-SLACKCFG-04). */
export type StoredReviewChannel = {
  channelId: string;
  /** Cached for display; Slack is the source of truth. */
  name: string;
  /** Deleted, archived or left: flagged in place, never dropped (FR-SLACKCFG-04 AC3). */
  missing: boolean;
  checkedAt: Date | null;
  addedAt: Date;
  addedBy: string;
};

export type ReviewChannelInput = Pick<
  StoredReviewChannel,
  "channelId" | "name" | "missing" | "checkedAt"
>;

export type ReviewChannelDiff = { added: string[]; removed: string[] };

/** What one `saveBundle` call writes. Every part is optional. */
export type SettingsBundle = {
  secrets?: Partial<Record<SecretKind, SecretWrite>>;
  values?: Partial<SettingValues>;
  removeSecrets?: readonly SecretKind[];
  removeValues?: readonly SettingKey[];
};

/** `at` and `by` stamp the written values (`updated_at`, `updated_by`). */
export type SettingsBundleOptions = {
  at: Date;
  by: string;
  event: (outcome: SettingsBundleOutcome) => NewReviewEvent;
};

/** What a `saveBundle` call changed. Lists are in `SECRET_KINDS` / `SETTING_KEYS` order. */
export type SettingsBundleOutcome = {
  savedSecrets: { kind: SecretKind; meta: SecretMeta; replaced: boolean }[];
  /** Values that were new or held a different value. */
  changedValues: SettingKey[];
  /** Secrets that existed and were removed. */
  removedSecrets: SecretMeta[];
  /** Values that existed and were removed. */
  removedValues: SettingKey[];
};

export const bundleChanged = (o: SettingsBundleOutcome): boolean =>
  o.savedSecrets.length > 0 ||
  o.changedValues.length > 0 ||
  o.removedSecrets.length > 0 ||
  o.removedValues.length > 0;

/** A parsed bundle, checked at the store boundary. */
export type ParsedSettingsBundle = {
  secrets: [SecretKind, SecretWrite][];
  values: [SettingKey, string | boolean][];
  removeSecrets: SecretKind[];
  removeValues: SettingKey[];
};

/**
 * Checks a bundle at the store boundary. Throws `InvalidSettingError` (never naming a value) for
 * an unknown kind or key, a bad value, an empty secret, or a kind / key both written and removed.
 */
export function parseSettingsBundle(bundle: SettingsBundle): ParsedSettingsBundle {
  if (typeof bundle !== "object" || bundle === null) {
    throw new InvalidSettingError(null, "bundle must be an object");
  }
  const rawSecrets = bundle.secrets ?? {};
  if (typeof rawSecrets !== "object" || rawSecrets === null || Array.isArray(rawSecrets)) {
    throw new InvalidSettingError(null, "secrets must be an object");
  }
  for (const kind of Object.keys(rawSecrets)) {
    if (!isSecretKind(kind)) throw new InvalidSettingError(null, "not a secret kind");
  }
  const secrets: [SecretKind, SecretWrite][] = [];
  for (const kind of SECRET_KINDS) {
    const write = (rawSecrets as Partial<Record<SecretKind, SecretWrite>>)[kind];
    if (write === undefined) continue;
    if (typeof write?.value !== "string" || write.value.length === 0) {
      throw new InvalidSettingError(null, `secret ${kind}: empty value`);
    }
    secrets.push([kind, write]);
  }
  const removeSecretsRaw = bundle.removeSecrets ?? [];
  if (!Array.isArray(removeSecretsRaw)) {
    throw new InvalidSettingError(null, "removeSecrets must be an array");
  }
  for (const kind of removeSecretsRaw) {
    if (!isSecretKind(kind)) throw new InvalidSettingError(null, "not a secret kind");
  }
  const removeSecrets = SECRET_KINDS.filter((k) => removeSecretsRaw.includes(k));
  const values = parseSettingValues(bundle.values ?? {});
  const removeValues = parseSettingKeys(bundle.removeValues ?? []);
  if (secrets.some(([kind]) => removeSecrets.includes(kind))) {
    throw new InvalidSettingError(null, "a secret kind is both saved and removed");
  }
  if (values.some(([key]) => removeValues.includes(key))) {
    throw new InvalidSettingError(null, "a setting key is both saved and removed");
  }
  return { secrets, values, removeSecrets, removeValues };
}

/**
 * The settings secrets (`setting_secret`, one row per kind) and the Slack review channels
 * (`slack_review_channel`). The store encrypts on save and decrypts on read with a cipher per
 * kind, so callers handle plaintext only; a value that fails to decrypt reads as `needs_reset`
 * and never throws.
 *
 * Every change records its history event in the same transaction (architecture.md §1 principle
 * 4): `event` builds it from the outcome, and if the event cannot be stored the change is rolled
 * back and the call rejects. `event` must be pure. Concurrent writes of one kind are serialised
 * by its row and the last one wins.
 */
export interface SettingsStore extends SettingValueStore {
  getSecret(kind: SecretKind): Promise<SecretRead>;
  /** Inserts or replaces the row of `kind`. `replaced` is true when a row existed before. */
  saveSecret(
    kind: SecretKind,
    write: SecretWrite,
    event: (outcome: { replaced: boolean; meta: SecretMeta }) => NewReviewEvent,
  ): Promise<{ meta: SecretMeta; replaced: boolean }>;
  /** Deletes the row. Null when there was nothing; then no event is recorded. */
  removeSecret(
    kind: SecretKind,
    event: (removed: SecretMeta) => NewReviewEvent,
  ): Promise<SecretMeta | null>;
  /**
   * Saves and removes secrets and values together, and records ONE event, all in one transaction:
   * either every write and the event commit, or nothing does (a section save, FR-SETTINGS-02).
   * The input is checked first (`parseSettingValues` / `parseSettingKeys`, known secret kinds, no
   * empty secret, no kind or key both written and removed); a refused bundle rejects and changes
   * nothing. Values equal to the stored ones are not written. `event` runs only when something
   * changed (`bundleChanged`); otherwise nothing is recorded. Concurrent bundles are serialised.
   */
  saveBundle(
    bundle: SettingsBundle,
    options: SettingsBundleOptions,
  ): Promise<SettingsBundleOutcome>;
  /**
   * Records that the secret saved as `version` verified (e.g. the signing secret on its first
   * signed event). False, and no change, when the row is gone or was replaced since. No event.
   */
  markSecretVerified(kind: SecretKind, version: number, at: Date): Promise<boolean>;

  /** Ordered by name, then id. */
  listReviewChannels(): Promise<StoredReviewChannel[]>;
  /**
   * Replaces the whole selection with `channels` (ids unique). Kept channels keep `addedAt` and
   * `addedBy`; their name, `missing` and `checkedAt` are updated. `event` runs only when the set
   * of ids changed. Concurrent calls are serialised.
   */
  setReviewChannels(
    channels: ReviewChannelInput[],
    options: { at: Date; by: string; event: (diff: ReviewChannelDiff) => NewReviewEvent },
  ): Promise<{ channels: StoredReviewChannel[]; diff: ReviewChannelDiff }>;
  /** Refreshes name and `missing` of listed channels after a Slack listing. No event. */
  updateReviewChannelChecks(
    checks: Pick<StoredReviewChannel, "channelId" | "name" | "missing">[],
    at: Date,
  ): Promise<void>;
}

/**
 * Every non-secret setting (`setting_value`, one row per key), a closed set. Secrets never go
 * here: they are `SecretKind`s in `setting_secret`. Provider selection is not a setting: it stays
 * "Anthropic if configured, otherwise OpenAI" (FR-LLMCFG-01).
 */
export const SETTING_KEYS = [
  // Retained storage keys for existing inert Jira records.
  "jira_base_url",
  "jira_email",
  "anthropic_base_url",
  "anthropic_model",
  "anthropic_auth_header",
  "anthropic_server_fallback",
  "openai_base_url",
  "openai_model",
  "openai_reasoning_effort",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export const isSettingKey = (value: unknown): value is SettingKey =>
  typeof value === "string" && (SETTING_KEYS as readonly string[]).includes(value);

export const ANTHROPIC_AUTH_HEADERS = ["bearer", "x-api-key"] as const;
export type AnthropicAuthHeader = (typeof ANTHROPIC_AUTH_HEADERS)[number];

/** The type of each setting. Shapes (URL, email, effort level) are checked by the domain. */
export type SettingValues = {
  jira_base_url: string;
  jira_email: string;
  anthropic_base_url: string;
  anthropic_model: string;
  anthropic_auth_header: AnthropicAuthHeader;
  anthropic_server_fallback: boolean;
  openai_base_url: string;
  openai_model: string;
  openai_reasoning_effort: string;
};

/** The longest string value, in UTF-16 code units. */
export const SETTING_VALUE_MAX_LENGTH = 2048;

const BOOLEAN_KEYS: ReadonlySet<SettingKey> = new Set(["anthropic_server_fallback"]);
/** C0, DEL, C1, and the Unicode line and paragraph separators. */
const hasControlChar = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
};

/** A key or value the store refuses. The message names the key (when known), never the value. */
export class InvalidSettingError extends Error {
  constructor(
    readonly key: SettingKey | null,
    reason: string,
  ) {
    super(`setting ${key ?? "(unknown key)"}: ${reason}`);
    this.name = "InvalidSettingError";
  }
}

/** Checks a list of keys at the store boundary. Returns them deduplicated, in `SETTING_KEYS` order. */
export function parseSettingKeys(keys: unknown): SettingKey[] {
  if (!Array.isArray(keys)) throw new InvalidSettingError(null, "keys must be an array");
  for (const key of keys) {
    if (!isSettingKey(key)) throw new InvalidSettingError(null, "not a setting key");
  }
  return SETTING_KEYS.filter((k) => keys.includes(k));
}

/**
 * Checks values at the store boundary: known keys, the right type, strings non-empty, at most
 * `SETTING_VALUE_MAX_LENGTH` long and free of control characters. An `undefined` entry is
 * skipped. Returns the entries in `SETTING_KEYS` order.
 */
export function parseSettingValues(values: unknown): [SettingKey, string | boolean][] {
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new InvalidSettingError(null, "values must be an object");
  }
  const record = values as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isSettingKey(key)) throw new InvalidSettingError(null, "not a setting key");
  }
  const entries: [SettingKey, string | boolean][] = [];
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(record, key) || record[key] === undefined) continue;
    const value = record[key];
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== "boolean") throw new InvalidSettingError(key, "must be a boolean");
    } else {
      if (typeof value !== "string") throw new InvalidSettingError(key, "must be a string");
      if (value.length === 0) throw new InvalidSettingError(key, "must not be empty");
      if (value.length > SETTING_VALUE_MAX_LENGTH) throw new InvalidSettingError(key, "too long");
      if (hasControlChar(value)) {
        throw new InvalidSettingError(key, "contains a control character");
      }
      if (
        key === "anthropic_auth_header" &&
        !(ANTHROPIC_AUTH_HEADERS as readonly string[]).includes(value)
      ) {
        throw new InvalidSettingError(key, "must be bearer or x-api-key");
      }
    }
    entries.push([key, value]);
  }
  return entries;
}

/**
 * The non-secret settings (`setting_value`). Keys and values are checked with
 * `parseSettingKeys` / `parseSettingValues` first; a refused call rejects with
 * `InvalidSettingError` and changes nothing. Like the secrets, every change records its event in
 * the same transaction (`event` must be pure; a failed event rolls the change back), and calls
 * that write are serialised, so `changed` / `removed` are computed against committed state.
 */
export interface SettingValueStore {
  /** The stored values of `keys`; a key with no value is absent from the result. */
  getValues<K extends SettingKey>(keys: readonly K[]): Promise<Partial<Pick<SettingValues, K>>>;
  /**
   * Inserts or replaces the given values; keys not given are left alone. `changed` lists, in
   * `SETTING_KEYS` order, the keys that were new or held a different value; unchanged keys are not
   * written. `event` runs only when `changed` is non-empty.
   */
  saveValues(
    values: Partial<SettingValues>,
    options: { at: Date; by: string; event: (change: { changed: SettingKey[] }) => NewReviewEvent },
  ): Promise<{ changed: SettingKey[] }>;
  /** Deletes the values of `keys`. `event` runs only when something was removed. */
  removeValues(
    keys: readonly SettingKey[],
    options: { event: (change: { removed: SettingKey[] }) => NewReviewEvent },
  ): Promise<{ removed: SettingKey[] }>;
}
