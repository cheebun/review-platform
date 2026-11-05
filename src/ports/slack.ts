import type { Result } from "../domain/shared/result";

export type SlackIdentity = {
  userId: string;
  teamId: string;
  teamUrl: string;
  /** Workspace name (`auth.test` `team`). */
  teamName: string;
  userName: string;
  /** True when the token is a bot token (`auth.test` returned `bot_id`). The review flow needs a user token. */
  isBot: boolean;
};

/** One channel from `conversations.list`. */
export type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  /** Whether the token's user is in the channel. Private channels are listed only when true. */
  isMember: boolean;
};

export type SlackChannelPage = { channels: SlackChannel[]; nextCursor?: string };

/**
 * The Slack Web API calls behind the `/settings` checks. All methods return a `Result` and never throw.
 * Errors map to `DomainError`; callers never see SDK error types or message strings.
 */
export interface SlackPort {
  authTest(): Promise<Result<SlackIdentity>>;
  /**
   * `conversations.list` of public and private channels, archived ones excluded, one cursor page
   * at a time. `nextCursor` is absent on the last page.
   */
  listConversations(input: { cursor?: string; limit?: number }): Promise<Result<SlackChannelPage>>;
}
