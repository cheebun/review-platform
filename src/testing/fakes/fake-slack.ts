import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { SlackChannel, SlackChannelPage, SlackIdentity, SlackPort } from "../../ports/slack";
import type { FailureKind, SlackWorld } from "../http/slack/slack-world";

const IDENTITY: SlackIdentity = {
  userId: "U1",
  teamId: "T1",
  teamUrl: "https://acme.slack.com/",
  teamName: "Acme",
  userName: "me",
  isBot: false,
};

function failureFor(kind: FailureKind, retryAfterS: number): DomainError {
  switch (kind) {
    case "rate_limited":
      return { kind: "rate_limited", retryAfterMs: retryAfterS * 1000 };
    case "auth":
      return { kind: "forbidden", reason: "slack_auth" };
    case "server_error":
      return { kind: "upstream", service: "slack", retryable: true };
  }
}

/**
 * In-memory Slack with real behaviour: conversation listing paginates, and a scripted failure
 * fails exactly one call.
 */
export class FakeSlack implements SlackPort, SlackWorld {
  identity: SlackIdentity = { ...IDENTITY };
  private channelList: SlackChannel[] = [];
  private pending: DomainError | null = null;

  // --- SlackWorld ---
  seedChannelList(channels: SlackChannel[]) {
    this.channelList = channels.map((c) => ({ ...c }));
  }
  failNext(kind: FailureKind, opts: { retryAfterS?: number } = {}) {
    this.pending = failureFor(kind, opts.retryAfterS ?? 1);
  }

  private take(): Result<never> | null {
    if (!this.pending) return null;
    const error = this.pending;
    this.pending = null;
    return err(error);
  }

  // --- SlackPort ---
  async authTest(): Promise<Result<SlackIdentity>> {
    return this.take() ?? ok({ ...this.identity });
  }

  async listConversations(input: {
    cursor?: string;
    limit?: number;
  }): Promise<Result<SlackChannelPage>> {
    const failure = this.take();
    if (failure) return failure;
    const start = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(start) || start < 0)
      return err({ kind: "validation", field: "cursor", message: "invalid cursor" });
    const end = start + (input.limit ?? 200);
    const channels = this.channelList.slice(start, end).map((c) => ({ ...c }));
    return ok(end < this.channelList.length ? { channels, nextCursor: String(end) } : { channels });
  }
}
