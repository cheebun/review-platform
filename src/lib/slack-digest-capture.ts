export type DigestMessage = {
  ts: string;
  channel: string;
  channelType?: string;
  user?: string;
  bot?: string;
  text: string;
  threadTs?: string;
};

const KEPT_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast", "bot_message"]);
const MAX_TEXT = 3000;

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function blockText(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(blockText);
  if (!node || typeof node !== "object") return [];
  const item = node as Record<string, unknown>;
  if (item.type === "user" && typeof item.user_id === "string") return [`<@${item.user_id}>`];
  if (item.type === "link" && typeof item.url === "string") return [str(item.text) ?? item.url];
  const own = typeof item.text === "string" ? [item.text] : blockText(item.text);
  return [...own, ...blockText(item.elements), ...blockText(item.fields)];
}

function attachmentText(attachment: unknown) {
  if (!attachment || typeof attachment !== "object") return undefined;
  const item = attachment as Record<string, unknown>;
  const fields = Array.isArray(item.fields)
    ? item.fields.map((field: { title?: unknown; value?: unknown }) =>
        [str(field?.title), str(field?.value)].filter(Boolean).join(": "),
      )
    : [];
  const parts = [
    str(item.pretext),
    str(item.author_name),
    str(item.title),
    str(item.text),
    ...fields,
  ].filter(Boolean) as string[];
  if (!parts.length) parts.push(str(blockText(item.blocks).join(" ")) ?? str(item.fallback) ?? "");
  return str(parts.join(" | "));
}

/** Bot messages often keep their content in blocks or attachments with an empty `text`. */
export function digestText(message: {
  text?: unknown;
  blocks?: unknown;
  attachments?: unknown;
  files?: unknown;
}) {
  const main = str(message.text) ?? str(blockText(message.blocks).join(" "));
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(attachmentText).filter(Boolean)
    : [];
  const files = Array.isArray(message.files) ? message.files.length : 0;
  const text =
    [main, ...attachments].filter(Boolean).join("\n") || (files ? `[${files} 个附件]` : "");
  return clip(text);
}

/** Pick new messages visible to the authorized user out of a Slack event payload; edits, deletes and joins are skipped. */
export function captureDigestMessage(
  payload: unknown,
  identity: { userId: string; teamId: string },
): DigestMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (body.type !== "event_callback" || body.team_id !== identity.teamId) return null;
  if (
    !Array.isArray(body.authorizations) ||
    !body.authorizations.some(
      (item: unknown) => (item as Record<string, unknown> | null)?.user_id === identity.userId,
    )
  )
    return null;
  const event = body.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "message" || event.hidden) return null;
  if (!KEPT_SUBTYPES.has(event.subtype as string | undefined)) return null;
  if (
    typeof event.channel !== "string" ||
    typeof event.ts !== "string" ||
    !/^\d+\.\d+$/.test(event.ts)
  )
    return null;
  const text = digestText(event);
  if (!text) return null;
  const botProfile = event.bot_profile as { name?: unknown } | undefined;
  const bot = event.bot_id ? String(botProfile?.name ?? event.username ?? "bot") : undefined;
  return {
    ts: event.ts,
    channel: event.channel,
    channelType: typeof event.channel_type === "string" ? event.channel_type : undefined,
    user: typeof event.user === "string" ? event.user : undefined,
    bot,
    text,
    threadTs:
      typeof event.thread_ts === "string" && event.thread_ts !== event.ts
        ? event.thread_ts
        : undefined,
  };
}
