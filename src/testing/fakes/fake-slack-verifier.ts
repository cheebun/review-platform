import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { SlackChannel, SlackChannelPage, SlackIdentity } from "../../ports/slack";
import type { SlackVerifier } from "../../ports/slack-verifier";
import type {
  SlackVerifierFailure,
  SlackVerifierWorld,
} from "../contracts/slack-verifier.contract";

export const IDENTITY: SlackIdentity = {
  userId: "U1",
  teamId: "T1",
  teamUrl: "https://acme.slack.com/",
  teamName: "Acme",
  userName: "me",
  isBot: false,
};

const FORBIDDEN: DomainError = { kind: "forbidden", reason: "slack_invalid_auth" };

function failureFor(kind: SlackVerifierFailure): DomainError {
  switch (kind) {
    case "auth":
      return FORBIDDEN;
    case "rate_limited":
      return { kind: "rate_limited", retryAfterMs: 1000 };
    case "server_error":
      return { kind: "upstream", service: "slack", retryable: true };
  }
}

type Call =
  | { method: "authTest"; token: string }
  | { method: "listConversations"; token: string; cursor?: string; limit?: number };

/**
 * In-memory Slack as `/settings` sees it: tokens are known or forbidden, listings paginate by
 * cursor, and a scripted failure fails exactly one call. `calls` records every request (tests
 * assert that a malformed value never reaches Slack).
 */
export class FakeSlackVerifier implements SlackVerifier, SlackVerifierWorld {
  readonly calls: Call[] = [];
  private users = new Map<string, SlackIdentity>();
  private lists = new Map<string, SlackChannel[]>();
  private pending: DomainError[] = [];

  userToken(token: string, identity: Partial<SlackIdentity> = {}): void {
    this.users.set(token, { ...IDENTITY, ...identity, isBot: false });
  }
  botToken(token: string): void {
    this.users.set(token, { ...IDENTITY, userId: "U0BOT", userName: "bot", isBot: true });
  }
  channels(token: string, list: SlackChannel[]): void {
    this.lists.set(
      token,
      list.map((c) => ({ ...c })),
    );
  }
  failNext(kind: SlackVerifierFailure): void {
    this.pending.push(failureFor(kind));
  }
  /** Fails the next call with exactly this error. */
  failNextWith(error: DomainError): void {
    this.pending.push(error);
  }

  private take(): Result<never> | null {
    const error = this.pending.shift();
    return error ? err(error) : null;
  }

  async authTest(token: string): Promise<Result<SlackIdentity>> {
    this.calls.push({ method: "authTest", token });
    const failure = this.take();
    if (failure) return failure;
    const identity = this.users.get(token);
    return identity ? ok({ ...identity }) : err(FORBIDDEN);
  }

  async listConversations(
    token: string,
    input: { cursor?: string; limit?: number },
  ): Promise<Result<SlackChannelPage>> {
    this.calls.push({ method: "listConversations", token, ...input });
    const failure = this.take();
    if (failure) return failure;
    if (!this.users.has(token)) return err(FORBIDDEN);
    const list = this.lists.get(token) ?? [];
    const start = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(start) || start < 0) {
      return err({ kind: "validation", field: "cursor", message: "invalid cursor" });
    }
    const end = start + (input.limit ?? 200);
    const channels = list.slice(start, end).map((c) => ({ ...c }));
    return ok(end < list.length ? { channels, nextCursor: String(end) } : { channels });
  }
}
