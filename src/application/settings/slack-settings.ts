import {
  isSlackSecretKind,
  MAX_REVIEW_CHANNELS,
  parseReviewChannelIds,
  parseSlackSecret,
  SLACK_SECRET_FIELD,
  SLACK_SECRET_KINDS,
  slackAvailability,
  toSlackSecretView,
  type SlackAvailability,
  type SlackSecretKind,
  type SlackSecretView,
} from "../../domain/settings/slack-settings";
import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { NewReviewEvent } from "../../ports/review-event-repo";
import type {
  ReviewChannelInput,
  SecretTestResult,
  StoredReviewChannel,
} from "../../ports/settings-store";
import type { SlackChannel } from "../../ports/slack";
import { SLACK_SETTINGS_CHANGED_CHANNEL } from "../slack/credentials";
import type { SlackSettingsDeps } from "./slack-deps";
import { FORBIDDEN_NON_USER } from "./view";

/**
 * Tells the worker and the web process to drop their cached Slack credentials. Best effort: a
 * failed publish only delays the switch until the cache expires, so it never fails the change.
 */
export async function publishSlackSettingsChanged(
  deps: Pick<SlackSettingsDeps, "wakeUp" | "logger">,
): Promise<void> {
  try {
    await deps.wakeUp.notify(SLACK_SETTINGS_CHANGED_CHANNEL);
  } catch (error) {
    deps.logger.warn("slack settings change not published", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Saves hit Slack (auth.test), so they are rate limited per user. */
export const SLACK_SAVE_LIMIT = { limit: 10, windowMs: 600_000 } as const;
/** A listing makes up to `CHANNEL_LIST_MAX_PAGES` Slack calls; listings are limited separately. */
export const SLACK_LIST_LIMIT = { limit: 30, windowMs: 600_000 } as const;
export const CHANNEL_LIST_PAGE_SIZE = 200;
/** At most 2000 channels per listing (assumed); beyond that the result is `truncated`. */
export const CHANNEL_LIST_MAX_PAGES = 10;
/** Overall budget of a listing, on top of the per-request timeout of the adapter. */
export const CHANNEL_LIST_DEADLINE_MS = 15_000;

const REJECTED: DomainError = { kind: "forbidden", reason: "Token rejected by Slack." };
const NOT_CONFIGURED: DomainError = { kind: "not_configured", feature: "slack" };
const NEEDS_RESET: DomainError = {
  kind: "not_configured",
  feature: "slack",
  reason: "needs_reset",
};
const UNKNOWN_KIND: DomainError = {
  kind: "validation",
  field: "kind",
  message: "Unknown Slack setting.",
};

export type SlackChannelSelectionView = {
  channelId: string;
  name: string;
  missing: boolean;
  checkedAt: string | null;
};

/** The Slack section of `/settings`. Never contains a secret value. */
export type SlackSettingsView = {
  availability: SlackAvailability;
  secrets: Record<SlackSecretKind, SlackSecretView>;
  /** Empty: every channel the user is in counts. DMs always count. */
  channels: SlackChannelSelectionView[];
  maxChannels: number;
};

export type SlackChannelOption = { id: string; name: string; isPrivate: boolean };
export type SlackChannelList = { channels: SlackChannelOption[]; truncated: boolean };

const toSelectionView = (c: StoredReviewChannel): SlackChannelSelectionView => ({
  channelId: c.channelId,
  name: c.name,
  missing: c.missing,
  checkedAt: c.checkedAt ? c.checkedAt.toISOString() : null,
});

async function buildView(deps: SlackSettingsDeps): Promise<SlackSettingsView> {
  const reads = await Promise.all(SLACK_SECRET_KINDS.map((k) => deps.settingsStore.getSecret(k)));
  const [user, signing] = reads;
  const channels = await deps.settingsStore.listReviewChannels();
  return {
    availability: slackAvailability({
      slack_user_token: user.state,
      slack_signing_secret: signing.state,
    }),
    secrets: {
      slack_user_token: toSlackSecretView(user),
      slack_signing_secret: toSlackSecretView(signing),
    },
    channels: channels.map(toSelectionView),
    maxChannels: MAX_REVIEW_CHANNELS,
  };
}

export async function getSlackSettingsView(
  deps: SlackSettingsDeps,
  actor: Actor,
): Promise<Result<SlackSettingsView>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  return ok(await buildView(deps));
}

/** The stored user token, for the channel listing and for 3g's Slack client. */
export async function resolveSlackUserToken(
  deps: Pick<SlackSettingsDeps, "settingsStore">,
): Promise<Result<string>> {
  const read = await deps.settingsStore.getSecret("slack_user_token");
  if (read.state === "ready") return ok(read.value);
  return err(read.state === "needs_reset" ? NEEDS_RESET : NOT_CONFIGURED);
}

export type CheckedSlackSecret = { verifiedAt: Date | null; testResult: SecretTestResult | null };
type Checked = CheckedSlackSecret;

/** FR-SLACKCFG-03: the check that runs before a value of `kind` is stored. */
export async function checkSlackSecret(
  deps: Pick<SlackSettingsDeps, "slackVerifier" | "clock">,
  kind: SlackSecretKind,
  value: string,
): Promise<Result<Checked>> {
  switch (kind) {
    case "slack_user_token": {
      const r = await deps.slackVerifier.authTest(value);
      if (!r.ok) return r.error.kind === "forbidden" ? err(REJECTED) : r;
      if (r.value.isBot) {
        return err({
          kind: "validation",
          field: SLACK_SECRET_FIELD.slack_user_token,
          message: "This token belongs to a bot. Use a user token (xoxp-).",
        });
      }
      const { userId, teamId, teamName, userName } = r.value;
      return ok({
        verifiedAt: deps.clock.now(),
        testResult: { userId, teamId, teamName, userName },
      });
    }
    case "slack_signing_secret":
      // Verified only by the first signed event (markSecretVerified); until then ⚠ 未验证.
      return ok({ verifiedAt: null, testResult: null });
  }
}

/**
 * Validate → check with Slack → store encrypted with its event (one transaction). A value Slack
 * rejects is `forbidden`; nothing is stored. The value never appears in a result, event or log.
 */
export async function saveSlackSecret(
  deps: SlackSettingsDeps,
  actor: Actor,
  input: { kind: unknown; value: unknown },
): Promise<Result<SlackSettingsView>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  if (!isSlackSecretKind(input.kind)) return err(UNKNOWN_KIND);
  const kind = input.kind;

  const limit = await deps.rateLimiter.hit(`slack-settings:${actor.userId}`, SLACK_SAVE_LIMIT);
  if (!limit.allowed) return err({ kind: "rate_limited", retryAfterMs: limit.retryAfterMs });

  const parsed = parseSlackSecret(kind, input.value);
  if (!parsed.ok) return parsed;
  const value = parsed.value;

  const checked = await checkSlackSecret(deps, kind, value);
  if (!checked.ok) return checked;

  const { replaced } = await storeSlackSecret(deps, actor.userId, kind, value, checked.value);
  deps.logger.info("slack secret saved", { kind, replaced, verified: !!checked.value.verifiedAt });
  await publishSlackSettingsChanged(deps);
  return ok(await buildView(deps));
}

/**
 * Stores a checked value encrypted with its event (one store transaction). `deps.settingsStore`
 * may be bound to an outer transaction (first-run setup).
 */
export function storeSlackSecret(
  deps: Pick<SlackSettingsDeps, "ids" | "clock" | "settingsStore">,
  userId: string,
  kind: SlackSecretKind,
  value: string,
  checked: CheckedSlackSecret,
) {
  const eventId = deps.ids.uuid();
  const now = deps.clock.now();
  return deps.settingsStore.saveSecret(
    kind,
    { value, savedAt: now, savedByUserId: userId, ...checked },
    (outcome): NewReviewEvent => ({
      id: eventId,
      type: "slack_secret_saved",
      actor: { kind: "user", id: userId },
      at: now,
      source: "web",
      detail: { kind, last4: outcome.meta.last4, replaced: outcome.replaced },
    }),
  );
}

export async function removeSlackSecret(
  deps: SlackSettingsDeps,
  actor: Actor,
  input: { kind: unknown },
): Promise<Result<SlackSettingsView>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  if (!isSlackSecretKind(input.kind)) return err(UNKNOWN_KIND);
  const kind = input.kind;
  const eventId = deps.ids.uuid();
  const now = deps.clock.now();
  const removed = await deps.settingsStore.removeSecret(kind, (meta) => ({
    id: eventId,
    type: "slack_secret_removed",
    actor: { kind: "user", id: actor.userId },
    at: now,
    source: "web",
    detail: { kind, last4: meta.last4 },
  }));
  if (removed) {
    deps.logger.info("slack secret removed", { kind });
    await publishSlackSettingsChanged(deps);
  }
  return ok(await buildView(deps));
}

type Listing = { channels: SlackChannel[]; truncated: boolean };

/** Paginates `conversations.list` within the page cap and the overall deadline. */
async function fetchMemberChannels(
  deps: SlackSettingsDeps,
  token: string,
): Promise<Result<Listing>> {
  const deadline = deps.clock.now().getTime() + CHANNEL_LIST_DEADLINE_MS;
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CHANNEL_LIST_MAX_PAGES; page++) {
    const r = await deps.slackVerifier.listConversations(token, {
      limit: CHANNEL_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!r.ok) return r;
    channels.push(...r.value.channels.filter((c) => c.isMember && !c.isArchived));
    cursor = r.value.nextCursor;
    if (!cursor) return ok({ channels, truncated: false });
    if (deps.clock.now().getTime() >= deadline) break;
  }
  return ok({ channels, truncated: true });
}

const byName = (a: SlackChannelOption, b: SlackChannelOption) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * FR-SLACKCFG-04: the public and private channels the user is in, for the picker. A complete
 * listing also refreshes the stored selection: renamed channels get their new name, and a
 * selected channel that is no longer listed is flagged `missing` (never dropped).
 */
export async function listSlackChannels(
  deps: SlackSettingsDeps,
  actor: Actor,
): Promise<Result<SlackChannelList>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  const token = await resolveSlackUserToken(deps);
  if (!token.ok) return token;

  const limit = await deps.rateLimiter.hit(`slack-channels:${actor.userId}`, SLACK_LIST_LIMIT);
  if (!limit.allowed) return err({ kind: "rate_limited", retryAfterMs: limit.retryAfterMs });

  const listing = await fetchMemberChannels(deps, token.value);
  if (!listing.ok) return listing;
  const { channels, truncated } = listing.value;

  const listed = new Map(channels.map((c) => [c.id, c]));
  const selected = await deps.settingsStore.listReviewChannels();
  const checks = selected
    .filter((c) => listed.has(c.channelId) || !truncated)
    .map((c) => {
      const hit = listed.get(c.channelId);
      return { channelId: c.channelId, name: hit?.name ?? c.name, missing: !hit };
    });
  await deps.settingsStore.updateReviewChannelChecks(checks, deps.clock.now());

  return ok({
    channels: channels
      .map((c) => ({ id: c.id, name: c.name, isPrivate: c.isPrivate }))
      .toSorted(byName),
    truncated,
  });
}

const UNKNOWN_CHANNEL: DomainError = {
  kind: "validation",
  field: "channels",
  message: "Pick channels you are a member of.",
};

/**
 * Replaces the review-channel selection. An empty selection means every channel and needs no
 * Slack call. Otherwise each id must be listed for the user, except one that was already
 * selected: it is kept and flagged `missing`. The event records counts only.
 */
export async function setSlackReviewChannels(
  deps: SlackSettingsDeps,
  actor: Actor,
  input: { channels: unknown },
): Promise<Result<SlackSettingsView>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  const parsed = parseReviewChannelIds(input.channels);
  if (!parsed.ok) return parsed;
  const ids = parsed.value;

  const now = deps.clock.now();
  const channels: ReviewChannelInput[] = [];
  if (ids.length > 0) {
    const token = await resolveSlackUserToken(deps);
    if (!token.ok) return token;
    const limit = await deps.rateLimiter.hit(`slack-settings:${actor.userId}`, SLACK_SAVE_LIMIT);
    if (!limit.allowed) return err({ kind: "rate_limited", retryAfterMs: limit.retryAfterMs });
    const listing = await fetchMemberChannels(deps, token.value);
    if (!listing.ok) return listing;
    const listed = new Map(listing.value.channels.map((c) => [c.id, c]));
    const previous = new Map(
      (await deps.settingsStore.listReviewChannels()).map((c) => [c.channelId, c]),
    );
    for (const id of ids) {
      const hit = listed.get(id);
      const kept = previous.get(id);
      if (hit) channels.push({ channelId: id, name: hit.name, missing: false, checkedAt: now });
      else if (kept) {
        channels.push({
          channelId: id,
          name: kept.name,
          missing: !listing.value.truncated || kept.missing,
          checkedAt: listing.value.truncated ? kept.checkedAt : now,
        });
      } else return err(UNKNOWN_CHANNEL);
    }
  }

  const eventId = deps.ids.uuid();
  const result = await deps.settingsStore.setReviewChannels(channels, {
    at: now,
    by: actor.userId,
    event: (diff) => ({
      id: eventId,
      type: "slack_channels_changed",
      actor: { kind: "user", id: actor.userId },
      at: now,
      source: "web",
      detail: { added: diff.added.length, removed: diff.removed.length, total: channels.length },
    }),
  });
  deps.logger.info("slack review channels set", {
    total: result.channels.length,
    added: result.diff.added.length,
    removed: result.diff.removed.length,
  });
  return ok(await buildView(deps));
}
