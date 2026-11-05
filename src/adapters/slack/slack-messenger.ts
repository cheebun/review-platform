import { LogLevel, WebClient } from "@slack/web-api";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { ReactionEmoji } from "../../domain/slack/status-emoji";
import type { ReactionSender, ThreadReplier } from "../../application/review/ports";
import { mapSlackError } from "./map-slack-error";

/** The owner's user token, resolved per call (it may be replaced on `/settings` at any time). */
export type SlackTokenSource = () => Promise<Result<string>>;

export type SlackMessengerOptions = {
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  slackApiUrl?: string;
};

type Message = { channel: string; ts: string; emoji: ReactionEmoji };

const platformCode = (e: unknown) => (e as { data?: { error?: unknown } } | null)?.data?.error;

/**
 * Thread replies and status reactions as the owner (FR-SLACK-05, FR-SLACK-08, FR-SLACK-13).
 * SDK retries are off and rate limits are returned (the outbox and `withRetry` own the retry
 * policy). Never throws; an error never carries the token or Slack's message text.
 */
export class SlackMessenger implements ThreadReplier, ReactionSender {
  constructor(
    private readonly token: SlackTokenSource,
    private readonly opts: SlackMessengerOptions = {},
  ) {}

  private async withClient(
    fn: (client: WebClient) => Promise<unknown>,
    tolerated: readonly string[] = [],
  ): Promise<Result<void>> {
    let token: Result<string>;
    try {
      token = await this.token();
    } catch {
      return err({ kind: "upstream", service: "slack", retryable: true });
    }
    if (!token.ok) return token;
    const client = new WebClient(token.value, {
      logLevel: LogLevel.ERROR,
      timeout: this.opts.timeoutMs ?? 10_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      ...(this.opts.slackApiUrl ? { slackApiUrl: this.opts.slackApiUrl } : {}),
    });
    try {
      await fn(client);
      return ok(undefined);
    } catch (error) {
      const code = platformCode(error);
      if (typeof code === "string" && tolerated.includes(code)) return ok(undefined);
      if (code === "invalid_name") {
        const invalid: DomainError = {
          kind: "validation",
          field: "emoji",
          message: "Slack does not know this emoji.",
        };
        return err(invalid);
      }
      return err(mapSlackError(error));
    }
  }

  reply(input: { channel: string; threadTs: string; text: string }): Promise<Result<void>> {
    return this.withClient((c) =>
      c.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: input.text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
  }

  add(input: Message): Promise<Result<void>> {
    return this.withClient(
      (c) => c.reactions.add({ channel: input.channel, timestamp: input.ts, name: input.emoji }),
      ["already_reacted"],
    );
  }

  remove(input: Message): Promise<Result<void>> {
    return this.withClient(
      (c) => c.reactions.remove({ channel: input.channel, timestamp: input.ts, name: input.emoji }),
      ["no_reaction"],
    );
  }
}
