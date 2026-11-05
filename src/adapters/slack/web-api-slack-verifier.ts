import { type Result } from "../../domain/shared/result";
import type { SlackChannelPage, SlackIdentity } from "../../ports/slack";
import type { SlackVerifier } from "../../ports/slack-verifier";
import { WebApiSlack } from "./web-api-slack";

export type WebApiSlackVerifierOptions = {
  /** Per-request timeout. Default 8 s, so a paginated listing stays within its overall budget. */
  timeoutMs?: number;
  slackApiUrl?: string;
};

/**
 * `SlackVerifier` over `@slack/web-api`. Each call builds a short-lived client for the token it
 * is given (a `WebApiSlack` for the shared methods), so a candidate token is held only for that
 * call. Retries are off and rate limits are returned, as in `WebApiSlack`.
 */
export class WebApiSlackVerifier implements SlackVerifier {
  private readonly timeoutMs: number;

  constructor(private readonly opts: WebApiSlackVerifierOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private slack(token: string): WebApiSlack {
    return new WebApiSlack({
      token,
      timeoutMs: this.timeoutMs,
      ...(this.opts.slackApiUrl ? { slackApiUrl: this.opts.slackApiUrl } : {}),
    });
  }

  authTest(token: string): Promise<Result<SlackIdentity>> {
    return this.slack(token).authTest();
  }

  listConversations(
    token: string,
    input: { cursor?: string; limit?: number },
  ): Promise<Result<SlackChannelPage>> {
    return this.slack(token).listConversations(input);
  }
}
