import { err, ok, type DomainError, type Result } from "../shared/result";

/**
 * The parts of a stored secret this module reads. Structurally the same as `SecretRead` in
 * `ports/settings-store.ts` (the domain may not import ports).
 */
type SecretFacts = Record<string, string | number | boolean | null>;
export type SecretReadState = "not_configured" | "needs_reset" | "ready";
type StoredSecretMeta = {
  last4: string;
  savedAt: Date;
  verifiedAt: Date | null;
  testResult: SecretFacts | null;
};
export type SecretReadLike =
  | { state: "not_configured" }
  | { state: "needs_reset" | "ready"; meta: StoredSecretMeta };

/** The HTTP Events API Slack secrets (FR-SLACKCFG-01), in page order. */
export const SLACK_SECRET_KINDS = ["slack_user_token", "slack_signing_secret"] as const;

export type SlackSecretKind = (typeof SLACK_SECRET_KINDS)[number];

export const isSlackSecretKind = (value: unknown): value is SlackSecretKind =>
  typeof value === "string" && (SLACK_SECRET_KINDS as readonly string[]).includes(value);

/** The form field of each kind: validation errors are shown on it. */
export const SLACK_SECRET_FIELD = {
  slack_user_token: "userToken",
  slack_signing_secret: "signingSecret",
} as const satisfies Record<SlackSecretKind, string>;

export type SlackSecretField = (typeof SLACK_SECRET_FIELD)[SlackSecretKind];

/** Upper bound for a selection (assumed); far above any real review-channel list. */
export const MAX_REVIEW_CHANNELS = 200;

/**
 * Real Slack tokens are 50+ characters. The lower bound (assumed) keeps `last4` from revealing a
 * meaningful share of a short value; the upper bound only caps the payload.
 */
const MIN_TOKEN_LENGTH = 24;
const MAX_TOKEN_LENGTH = 512;

/** Visible ASCII only: rejects whitespace and control characters anywhere inside. */
const VISIBLE_RE = /^[\x21-\x7e]+$/;
/** `xoxp-`, or a rotating user token `xoxe.xoxp-`. */
const USER_TOKEN_RE = /^(?:xoxe\.)?xoxp-/;
/** Slack signing secrets are 32 hex characters; the check is loose (FR-SLACKCFG-03, assumed). */
const SIGNING_SECRET_RE = /^[0-9a-fA-F]{16,128}$/;
/** Public (`C`) and legacy private (`G`) channel ids. DMs (`D`) always count and are not stored. */
const CHANNEL_ID_RE = /^[CG][A-Z0-9]{2,20}$/;

type Rule = { re: RegExp; minLength: number; message: string };

/** Fixed messages: they never include the input, which is a credential. */
const RULES: Record<SlackSecretKind, Rule> = {
  slack_user_token: {
    re: USER_TOKEN_RE,
    minLength: MIN_TOKEN_LENGTH,
    message: "A user token starts with xoxp- and has no spaces.",
  },
  slack_signing_secret: {
    re: SIGNING_SECRET_RE,
    minLength: 16,
    message: "A signing secret is 16 to 128 hex characters.",
  },
};

/** FR-SLACKCFG-03 format checks. Surrounding whitespace (a pasted newline) is trimmed first. */
export function parseSlackSecret(kind: SlackSecretKind, input: unknown): Result<string> {
  const rule = RULES[kind];
  const field = SLACK_SECRET_FIELD[kind];
  const invalid = (message: string): Result<string> => err({ kind: "validation", field, message });
  if (typeof input !== "string") return invalid("The value must be a string.");
  const value = input.trim();
  if (value.length === 0) return invalid("A value is required.");
  if (
    value.length < rule.minLength ||
    value.length > MAX_TOKEN_LENGTH ||
    !VISIBLE_RE.test(value) ||
    !rule.re.test(value)
  ) {
    return invalid(rule.message);
  }
  return ok(value);
}

/** The review-channel selection: unique channel ids, in the order given. */
const invalidChannels = (message: string): Result<string[]> =>
  err<DomainError>({ kind: "validation", field: "channels", message });

export function parseReviewChannelIds(input: unknown): Result<string[]> {
  const invalid = invalidChannels;
  if (!Array.isArray(input)) return invalid("Channels must be a list.");
  const ids: string[] = [];
  for (const id of input) {
    if (typeof id !== "string" || !CHANNEL_ID_RE.test(id)) {
      return invalid("Every channel must be a Slack channel id.");
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_REVIEW_CHANNELS) {
    return invalid(`At most ${MAX_REVIEW_CHANNELS} channels can be selected.`);
  }
  return ok(ids);
}

export type SlackAvailability = "not_configured" | "needs_reset" | "ready";

/**
 * FR-SLACKCFG-02: any secret that cannot be decrypted → 需要重新设置; otherwise no user token →
 * Slack 未配置; otherwise ready. The signing secret gates HTTP event verification.
 */
export function slackAvailability(
  states: Record<SlackSecretKind, SecretReadState>,
): SlackAvailability {
  if (SLACK_SECRET_KINDS.some((k) => states[k] === "needs_reset")) return "needs_reset";
  return states.slack_user_token === "ready" ? "ready" : "not_configured";
}

/** What the browser may see about one secret. Never the value. Dates are ISO strings. */
export type SlackSecretView =
  | { state: "unset" }
  | {
      state: "set" | "needs_reset";
      last4: string;
      savedAt: string;
      /** Null: saved but not verified (⚠ 未验证). */
      verifiedAt: string | null;
      /** User token only: from `auth.test`. */
      teamName?: string;
      userName?: string;
    };

const text = (result: SecretFacts | null, key: string): string | undefined => {
  const value = result?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** Explicit pick: the value, ids and the saver never reach the client. */
export function toSlackSecretView(read: SecretReadLike): SlackSecretView {
  if (read.state === "not_configured") return { state: "unset" };
  const { meta } = read;
  const teamName = text(meta.testResult, "teamName");
  const userName = text(meta.testResult, "userName");
  return {
    state: read.state === "ready" ? "set" : "needs_reset",
    last4: meta.last4,
    savedAt: meta.savedAt.toISOString(),
    verifiedAt: meta.verifiedAt ? meta.verifiedAt.toISOString() : null,
    ...(teamName ? { teamName } : {}),
    ...(userName ? { userName } : {}),
  };
}

/** The search box (FR-SLACKCFG-04): a case-insensitive name substring; a leading `#` is ignored. */
export function filterChannels<T extends { name: string }>(channels: T[], query: string): T[] {
  const q = query.trim().replace(/^#/, "").toLowerCase();
  if (q === "") return channels;
  return channels.filter((c) => c.name.toLowerCase().includes(q));
}
