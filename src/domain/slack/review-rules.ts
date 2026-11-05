export type SlackReviewMessage = {
  /** Stable dedupe seed `team:channel:ts`. The adapter layer hashes it (domain has no node:crypto). */
  key: string;
  channel: string;
  ts: string;
  threadTs?: string;
  sender: string;
  /** Canonical PR URLs for listed repos, deduplicated, in first-seen order. */
  urls: string[];
};

export type ActiveHours = { start: number; end: number };

export type ReviewRuleOptions = {
  /** The owner's Slack user id (from `auth.test`). Messages must mention it. */
  userId: string;
  teamId: string;
  /**
   * The stored `/settings` repo list as canonical `owner/repo` strings (FR-GITHUB-07). Matched
   * case-insensitively. An empty list matches nothing. There is no sender allowlist (FR-SLACK-04).
   */
  repoList: readonly string[];
  /** Review channels (FR-SLACKCFG-04). Empty or omitted means all channels; DMs always count. */
  channelIds?: readonly string[];
  /** UTC+8 hours [start, end); omitted means always active. */
  activeHours?: ActiveHours;
};

export const SLACK_REVIEW_ACTIVE_HOURS: ActiveHours = { start: 9, end: 19 };

/** China has no DST, so UTC+8 is a fixed offset. */
export function withinActiveHours(epochMs: number, hours: ActiveHours): boolean {
  const hour = new Date(epochMs + 8 * 60 * 60 * 1000).getUTCHours();
  return hour >= hours.start && hour < hours.end;
}

/**
 * Generic GitHub PR URL. Owner and repo follow the repo-entry format (FR-GITHUB-07). The PR
 * number has no leading zero. The tab suffixes are optional, and the URL must end at a delimiter,
 * which covers Slack's `<url|label>` and `<url>` wrapping. Linear: no nested quantifiers.
 */
const PR_URL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d*)(?:\/(?:files|changes|commits|checks)?\/?)?(?=[\s<>|)\]?#.,]|$)/gi;

/**
 * PR URLs in `text` whose `owner/repo` is in `repoList`, normalised to the list's canonical
 * spelling (`https://github.com/<canonical>/pull/<n>`), deduplicated, in first-seen order.
 * Pure: the list is passed in, never read here.
 */
export function extractReviewPrUrls(text: string, repoList: readonly string[]): string[] {
  if (typeof text !== "string" || repoList.length === 0) return [];
  const canonicalByKey = new Map<string, string>();
  for (const entry of repoList) {
    if (typeof entry !== "string") continue;
    const canonical = entry.trim();
    const key = canonical.toLowerCase();
    if (canonical && !canonicalByKey.has(key)) canonicalByKey.set(key, canonical);
  }
  const urls = new Set<string>();
  for (const match of text.matchAll(PR_URL_RE)) {
    const canonical = canonicalByKey.get(`${match[1]}/${match[2]}`.toLowerCase());
    if (!canonical) continue;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number)) continue;
    urls.add(`https://github.com/${canonical}/pull/${number}`);
  }
  return [...urls];
}

/** Match new human messages from any workspace member addressed to the owner (FR-SLACK-03). */
export function matchSlackReviewMessage(
  payload: unknown,
  options: ReviewRuleOptions,
): SlackReviewMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (body.team_id !== options.teamId || body.type !== "event_callback") return null;
  if (
    !Array.isArray(body.authorizations) ||
    !body.authorizations.some((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const authorization = item as Record<string, unknown>;
      return authorization.user_id === options.userId && authorization.is_bot === false;
    })
  )
    return null;
  if (!body.event || typeof body.event !== "object") return null;
  const event = body.event as Record<string, unknown>;
  if (event.type !== "message" || event.bot_id || event.hidden) return null;
  if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast")
    return null;
  if (typeof event.user !== "string") return null;
  if (
    typeof event.channel !== "string" ||
    typeof event.ts !== "string" ||
    !/^\d+\.\d+$/.test(event.ts)
  )
    return null;
  if (typeof event.text !== "string") return null;
  // Judge by the message's own send time, so Slack retries after hours still match.
  if (options.activeHours && !withinActiveHours(Number(event.ts) * 1000, options.activeHours))
    return null;
  const direct = event.channel_type === "im";
  const mentioned = event.text.includes(`<@${options.userId}>`);
  if (!mentioned) return null;
  if (!direct && options.channelIds?.length && !options.channelIds.includes(event.channel))
    return null;
  const urls = extractReviewPrUrls(event.text, options.repoList);
  if (!urls.length) return null;
  return {
    key: `${options.teamId}:${event.channel}:${event.ts}`,
    channel: event.channel,
    ts: event.ts,
    threadTs: typeof event.thread_ts === "string" ? event.thread_ts : undefined,
    sender: event.user,
    urls,
  };
}
