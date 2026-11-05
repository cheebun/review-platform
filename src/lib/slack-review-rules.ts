import { createHash } from "node:crypto";

export type SlackReviewMessage = {
  id: string;
  channel: string;
  ts: string;
  threadTs?: string;
  sender: string;
  urls: string[];
};

type ActiveHours = { start: number; end: number };
type RuleOptions = {
  userId: string;
  teamId: string;
  senderIds?: readonly string[];
  channelIds?: string[];
  /** UTC+8 hours [start, end); omitted means always active. */
  activeHours?: ActiveHours;
};

export const SLACK_REVIEW_ACTIVE_HOURS: ActiveHours = { start: 9, end: 19 };

/** China has no DST, so UTC+8 is a fixed offset. */
export function withinActiveHours(epochMs: number, hours: ActiveHours) {
  const hour = new Date(epochMs + 8 * 60 * 60 * 1000).getUTCHours();
  return hour >= hours.start && hour < hours.end;
}

export function extractReviewPrUrls(text: string): string[] {
  const pattern =
    /https:\/\/github\.com\/bosinc\/katana-web\/pull\/([1-9]\d*)(?:\/(?:files|changes|commits|checks)?\/?)?(?=[\s<>|)\]?#.,]|$)/gi;
  const urls = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number))
      urls.add(`https://github.com/bosinc/katana-web/pull/${number}`);
  }
  return [...urls];
}

/** Match new human messages addressed to the authorized Slack user. */
export function matchSlackReviewMessage(
  payload: unknown,
  options: RuleOptions,
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
  const urls = extractReviewPrUrls(event.text);
  if (!urls.length) return null;
  return {
    id: createHash("sha256").update(`${options.teamId}:${event.channel}:${event.ts}`).digest("hex"),
    channel: event.channel,
    ts: event.ts,
    threadTs: typeof event.thread_ts === "string" ? event.thread_ts : undefined,
    sender: event.user,
    urls,
  };
}
