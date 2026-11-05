import { WebClient, LogLevel } from "@slack/web-api";
import { err, ok, type Result } from "../../domain/shared/result";
import type { SlackChannelPage, SlackIdentity, SlackPort } from "../../ports/slack";
import { mapSlackError } from "./map-slack-error";

export type WebApiSlackOptions = {
  token: string;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  slackApiUrl?: string;
};

/**
 * `@slack/web-api` behind `SlackPort`. The SDK's own retries are disabled and rate-limited
 * calls are rejected, so retry policy (and Retry-After handling) lives in the use cases, where
 * it is testable, instead of hidden sleeps inside the client.
 */
export class WebApiSlack implements SlackPort {
  private readonly client: WebClient;

  constructor(opts: WebApiSlackOptions) {
    this.client = new WebClient(opts.token, {
      logLevel: LogLevel.ERROR,
      timeout: opts.timeoutMs ?? 10_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      ...(opts.slackApiUrl ? { slackApiUrl: opts.slackApiUrl } : {}),
    });
  }

  private async call<T>(fn: () => Promise<T>): Promise<Result<T>> {
    try {
      return ok(await fn());
    } catch (error) {
      return err(mapSlackError(error));
    }
  }

  /** Slack answered `ok` but omitted a field we need. */
  private malformed(): Result<never> {
    return err({ kind: "upstream", service: "slack", retryable: false });
  }

  async authTest(): Promise<Result<SlackIdentity>> {
    const r = await this.call(() => this.client.auth.test());
    if (!r.ok) return r;
    const a = r.value;
    if (!a.user_id || !a.team_id) return this.malformed();
    return ok({
      userId: a.user_id,
      teamId: a.team_id,
      teamUrl: a.url ?? "",
      teamName: a.team ?? "",
      userName: a.user ?? "",
      isBot: Boolean(a.bot_id),
    });
  }

  async listConversations(input: {
    cursor?: string;
    limit?: number;
  }): Promise<Result<SlackChannelPage>> {
    const r = await this.call(() =>
      this.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: input.limit ?? 200,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    );
    if (!r.ok) return r;
    const channels = (r.value.channels ?? []).flatMap((c) =>
      c.id && c.name
        ? [
            {
              id: c.id,
              name: c.name,
              isPrivate: Boolean(c.is_private),
              isArchived: Boolean(c.is_archived),
              isMember: Boolean(c.is_member),
            },
          ]
        : [],
    );
    const nextCursor = r.value.response_metadata?.next_cursor || undefined;
    return ok(nextCursor ? { channels, nextCursor } : { channels });
  }
}
