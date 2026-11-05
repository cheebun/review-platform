import type { Result } from "../domain/shared/result";
import type { SlackChannelPage, SlackIdentity } from "./slack";

/**
 * Slack checks for `/settings` (FR-SLACKCFG-03, -04). The token is passed per call and held
 * only for that call, so a candidate can be checked before it is stored. Read-only: no method
 * posts, reacts or changes anything in Slack. Never throws.
 *
 * Errors: `forbidden` (invalid, revoked or wrong-type token, missing scope), `rate_limited`,
 * `upstream` (5xx, network, timeout).
 */
export interface SlackVerifier {
  /** `auth.test`. The caller refuses `isBot` for the user token. */
  authTest(token: string): Promise<Result<SlackIdentity>>;
  /** `conversations.list`, public and private, archived excluded; one cursor page. */
  listConversations(
    token: string,
    input: { cursor?: string; limit?: number },
  ): Promise<Result<SlackChannelPage>>;
}
