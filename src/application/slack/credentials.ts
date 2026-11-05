/**
 * The Slack credentials, read from the encrypted `SettingsStore` (FR-SLACKCFG-01..03), never from
 * env. Each kind is cached for `SLACK_CREDENTIAL_TTL_MS` so a burst of Slack events costs one
 * decrypting read; `invalidate()` drops the cache (the worker and the web process call it when
 * `SLACK_SETTINGS_CHANGED_CHANNEL` fires). Concurrent callers share one read; a throwing read is
 * re-thrown and never cached, so a database outage is retried by the next caller.
 */
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { SecretRead, SettingsStore } from "../../ports/settings-store";
import type { Clock } from "../../ports/system";

export const SLACK_CREDENTIAL_TTL_MS = 60_000;
/** A forced re-read (after a signature mismatch) happens at most this often per kind. */
export const SLACK_REFRESH_MIN_INTERVAL_MS = 5_000;
/** WakeUp channel notified when a Slack secret is saved or removed (3j / 3w publish it). */
export const SLACK_SETTINGS_CHANGED_CHANNEL = "slack-settings:changed";

export type SlackSecret = { value: string; version: number; verified: boolean };
export type SlackOwner = { userId: string; teamId: string };
export type SlackCredentialKind = "slack_user_token" | "slack_signing_secret";

const FEATURE = {
  slack_user_token: "slack",
  slack_signing_secret: "slack_events",
} as const satisfies Record<SlackCredentialKind, string>;

const USER_ID = /^[UW][A-Z0-9]{2,30}$/;
const TEAM_ID = /^[TE][A-Z0-9]{2,30}$/;

type Snapshot =
  | { state: "not_configured" | "needs_reset" }
  | {
      state: "ready";
      value: string;
      version: number;
      verified: boolean;
      owner: SlackOwner | null;
    };

type Entry = { at: number; snapshot: Snapshot };

function snapshotOf(read: SecretRead): Snapshot {
  if (read.state !== "ready") return { state: read.state };
  const t = read.meta.testResult;
  const userId = t?.userId;
  const teamId = t?.teamId;
  const owner =
    typeof userId === "string" &&
    typeof teamId === "string" &&
    USER_ID.test(userId) &&
    TEAM_ID.test(teamId)
      ? { userId, teamId }
      : null;
  return {
    state: "ready",
    value: read.value,
    version: read.meta.version,
    verified: read.meta.verifiedAt !== null,
    owner,
  };
}

function notConfigured(kind: SlackCredentialKind, snapshot: Snapshot): DomainError {
  return snapshot.state === "needs_reset"
    ? { kind: "not_configured", feature: FEATURE[kind], reason: "needs_reset" }
    : { kind: "not_configured", feature: FEATURE[kind] };
}

export type SlackCredentialsDeps = {
  settingsStore: Pick<SettingsStore, "getSecret">;
  clock: Clock;
  ttlMs?: number;
};

export class SlackCredentials {
  private readonly cache = new Map<SlackCredentialKind, Entry>();
  private readonly inflight = new Map<SlackCredentialKind, Promise<Snapshot>>();
  private readonly lastRefresh = new Map<SlackCredentialKind, number>();
  /** Bumped by `invalidate`; a read started before it is not cached. */
  private generation = 0;

  constructor(private readonly deps: SlackCredentialsDeps) {}

  private get ttlMs(): number {
    return this.deps.ttlMs ?? SLACK_CREDENTIAL_TTL_MS;
  }

  private now(): number {
    return this.deps.clock.now().getTime();
  }

  private load(kind: SlackCredentialKind): Promise<Snapshot> {
    const pending = this.inflight.get(kind);
    if (pending) return pending;
    const generation = this.generation;
    const read = (async () => {
      const snapshot = snapshotOf(await this.deps.settingsStore.getSecret(kind));
      if (generation === this.generation) this.cache.set(kind, { at: this.now(), snapshot });
      return snapshot;
    })();
    this.inflight.set(kind, read);
    const settle = () => {
      if (this.inflight.get(kind) === read) this.inflight.delete(kind);
    };
    read.then(settle, settle);
    return read;
  }

  private async snapshot(kind: SlackCredentialKind): Promise<Snapshot> {
    const hit = this.cache.get(kind);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.snapshot;
    return this.load(kind);
  }

  private async secret(kind: SlackCredentialKind): Promise<Result<SlackSecret>> {
    const s = await this.snapshot(kind);
    if (s.state !== "ready") return err(notConfigured(kind, s));
    return ok({ value: s.value, version: s.version, verified: s.verified });
  }

  /** `SLACK_SIGNING_SECRET` replacement, for `/api/slack/events` (feature `slack_events`). */
  signingSecret(): Promise<Result<SlackSecret>> {
    return this.secret("slack_signing_secret");
  }

  /** The owner's user token, used for every reply and reaction (feature `slack`). */
  async userToken(): Promise<Result<string>> {
    const r = await this.secret("slack_user_token");
    return r.ok ? ok(r.value.value) : r;
  }

  /** The owner's Slack identity, from the `auth.test` result stored with the user token. */
  async owner(): Promise<Result<SlackOwner>> {
    const s = await this.snapshot("slack_user_token");
    if (s.state !== "ready") return err(notConfigured("slack_user_token", s));
    return s.owner ? ok(s.owner) : err({ kind: "not_configured", feature: "slack" });
  }

  /**
   * Re-reads `kind` past the cache, at most once per `SLACK_REFRESH_MIN_INTERVAL_MS`. True when
   * the stored version changed (a secret saved within the TTL), so the caller may retry once.
   */
  async refresh(kind: SlackCredentialKind): Promise<boolean> {
    const now = this.now();
    const last = this.lastRefresh.get(kind);
    if (last !== undefined && now - last < SLACK_REFRESH_MIN_INTERVAL_MS) return false;
    this.lastRefresh.set(kind, now);
    const before = this.cache.get(kind)?.snapshot;
    const versionOf = (s: Snapshot | undefined) => (s?.state === "ready" ? s.version : null);
    this.cache.delete(kind);
    const after = await this.load(kind);
    return versionOf(after) !== versionOf(before);
  }

  /** Records in the cache that `version` verified, so it is marked in the store only once. */
  markVerified(kind: SlackCredentialKind, version: number): void {
    const hit = this.cache.get(kind);
    if (hit?.snapshot.state === "ready" && hit.snapshot.version === version) {
      hit.snapshot = { ...hit.snapshot, verified: true };
    }
  }

  /** Drops every cached value; the next call reads the store. */
  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.inflight.clear();
  }
}
