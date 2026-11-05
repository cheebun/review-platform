/**
 * Slack thread commands (FR-SLACK-13, FR-SLACK-14, architecture §4.3). Pure.
 *
 * The app posts its own thread replies with the owner's user token, so those posts carry
 * sender = owner. Safety rests on exact whole-text matching: a reply is a command only when its
 * entire text, trimmed, lower-cased and with internal whitespace collapsed, equals a command.
 */

export type OwnerCommand = "review" | "approve" | "force_approve" | "merge";
export type RequesterCommand = "updated";
export type ThreadCommandName = OwnerCommand | RequesterCommand;

export type ThreadCommandIgnoreReason =
  /** Not an object, or a required field (user, text, channel, ts) is missing or malformed. */
  | "invalid_event"
  | "not_message"
  /** `message_changed`: an edit whose new text is a command still does nothing. */
  | "edited"
  | "deleted"
  | "unsupported_subtype"
  | "bot"
  | "hidden"
  /** Top-level message, or the thread root itself. */
  | "not_thread"
  | "unknown_text"
  | "not_owner"
  | "not_requester";

export type ThreadCommandContext = {
  /** The owner's Slack user id, from `auth.test`. */
  ownerId: string;
  /** The requester recorded on the thread's review, when there is one. */
  requesterId?: string;
};

export type ParsedThreadCommand =
  | {
      kind: "command";
      command: ThreadCommandName;
      sender: string;
      channel: string;
      threadTs: string;
      ts: string;
    }
  /** `sender` is set once the event is well-formed, so refused attempts can be logged. */
  | { kind: "ignored"; reason: ThreadCommandIgnoreReason; sender?: string };

const COMMANDS: ReadonlyMap<string, ThreadCommandName> = new Map([
  ["review", "review"],
  ["approve", "approve"],
  ["force approve", "force_approve"],
  ["merge", "merge"],
  ["updated", "updated"],
]);

const OWNER_COMMANDS: ReadonlySet<ThreadCommandName> = new Set<ThreadCommandName>([
  "review",
  "approve",
  "force_approve",
  "merge",
]);

const SLACK_TS_RE = /^\d+\.\d+$/;
/** Longer text cannot be a command; skip normalising it. */
const MAX_COMMAND_TEXT = 64;

const ignored = (
  reason: ThreadCommandIgnoreReason,
  sender?: string,
): ParsedThreadCommand & { kind: "ignored" } =>
  sender === undefined ? { kind: "ignored", reason } : { kind: "ignored", reason, sender };

/** Exact command match: trim, collapse internal whitespace (incl. NBSP), compare lower-case. */
function matchCommandText(text: string): ThreadCommandName | undefined {
  if (text.length > MAX_COMMAND_TEXT) return undefined;
  return COMMANDS.get(text.trim().replace(/\s+/g, " ").toLowerCase());
}

/**
 * Parse a Slack `message` event (the inner `event` object) as a thread command.
 * Never throws. Text is checked before the sender, so ordinary chat is `unknown_text`.
 */
export function parseThreadCommand(event: unknown, ctx: ThreadCommandContext): ParsedThreadCommand {
  if (!event || typeof event !== "object") return ignored("invalid_event");
  const e = event as Record<string, unknown>;
  if (e.type !== "message") return ignored("not_message");

  const subtype = e.subtype;
  if (subtype === "message_changed") return ignored("edited");
  if (subtype === "message_deleted") return ignored("deleted");
  if (subtype === "bot_message" || e.bot_id) return ignored("bot");
  if (e.hidden) return ignored("hidden");
  if (subtype !== undefined && subtype !== "thread_broadcast")
    return ignored("unsupported_subtype");

  const { user, text, channel, ts } = e;
  if (
    typeof user !== "string" ||
    user.length === 0 ||
    typeof text !== "string" ||
    typeof channel !== "string" ||
    channel.length === 0 ||
    typeof ts !== "string" ||
    !SLACK_TS_RE.test(ts)
  )
    return ignored("invalid_event");

  const threadTs = e.thread_ts;
  if (typeof threadTs !== "string" || !SLACK_TS_RE.test(threadTs) || threadTs === ts)
    return ignored("not_thread", user);

  const command = matchCommandText(text);
  if (!command) return ignored("unknown_text", user);

  if (OWNER_COMMANDS.has(command)) {
    if (user !== ctx.ownerId) return ignored("not_owner", user);
  } else if (ctx.requesterId === undefined || user !== ctx.requesterId) {
    // `updated` belongs to the recorded requester only, not even the owner (FR-SLACK-14 (a)).
    return ignored("not_requester", user);
  }

  return { kind: "command", command, sender: user, channel, threadTs, ts };
}
