import type { SlackChannel } from "../../../ports/slack";

export type FailureKind = "rate_limited" | "auth" | "server_error";

/**
 * Test-side control over a Slack implementation: seeds data and scripts failures. Implemented
 * by `FakeSlack` directly and by the msw server in `slack-msw.ts`, so one contract suite can
 * drive both.
 */
export interface SlackWorld {
  /** What `conversations.list` returns, in order. */
  seedChannelList(channels: SlackChannel[]): void;
  /** The next API call fails once with this failure. */
  failNext(kind: FailureKind, opts?: { retryAfterS?: number }): void;
}
