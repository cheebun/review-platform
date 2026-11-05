import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlackChannel, SlackIdentity } from "../../ports/slack";
import type { SlackVerifier } from "../../ports/slack-verifier";

// Obviously fake tokens, never real credentials.
export const FAKE_USER_TOKEN = "xoxp-0000-FAKE-verifier-user-token-0001";
export const FAKE_BOT_TOKEN = "xoxb-0000-FAKE-verifier-bot-token-0002";
export const UNKNOWN_TOKEN = "xoxp-0000-FAKE-verifier-unknown-0004";

export type SlackVerifierFailure = "auth" | "rate_limited" | "server_error";

/** Test-side control over Slack as the verifier sees it, implemented by the fake and by msw. */
export interface SlackVerifierWorld {
  userToken(token: string, identity?: Partial<SlackIdentity>): void;
  botToken(token: string): void;
  channels(token: string, list: SlackChannel[]): void;
  /** The next API call fails once. */
  failNext(kind: SlackVerifierFailure): void;
}

export type SlackVerifierHarness = {
  impl: SlackVerifier;
  world: SlackVerifierWorld;
  cleanup(): Promise<void>;
};

const channel = (n: number, over: Partial<SlackChannel> = {}): SlackChannel => ({
  id: `C${1000 + n}`,
  name: `channel-${n}`,
  isPrivate: false,
  isArchived: false,
  isMember: true,
  ...over,
});

export function slackVerifierContract(make: () => Promise<SlackVerifierHarness>) {
  describe("SlackVerifier contract", () => {
    let h: SlackVerifierHarness;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("authTest returns the identity of a user token", async () => {
      h.world.userToken(FAKE_USER_TOKEN, { userId: "U9", userName: "owner", teamName: "Acme" });
      expect(await h.impl.authTest(FAKE_USER_TOKEN)).toEqual({
        ok: true,
        value: {
          userId: "U9",
          teamId: "T1",
          teamUrl: "https://acme.slack.com/",
          teamName: "Acme",
          userName: "owner",
          isBot: false,
        },
      });
    });

    it("authTest flags a bot token", async () => {
      h.world.botToken(FAKE_BOT_TOKEN);
      expect(await h.impl.authTest(FAKE_BOT_TOKEN)).toMatchObject({
        ok: true,
        value: { isBot: true },
      });
    });

    it("an unknown token is forbidden on every method", async () => {
      expect(await h.impl.authTest(UNKNOWN_TOKEN)).toMatchObject({
        ok: false,
        error: { kind: "forbidden" },
      });
      expect(await h.impl.listConversations(UNKNOWN_TOKEN, {})).toMatchObject({
        ok: false,
        error: { kind: "forbidden" },
      });
    });

    it("listConversations pages through the token's channels", async () => {
      h.world.userToken(FAKE_USER_TOKEN);
      const list = [channel(1), channel(2, { isPrivate: true, id: "G1002" }), channel(3)];
      h.world.channels(FAKE_USER_TOKEN, list);
      const first = await h.impl.listConversations(FAKE_USER_TOKEN, { limit: 2 });
      expect(first).toEqual({
        ok: true,
        value: { channels: list.slice(0, 2), nextCursor: expect.any(String) },
      });
      const cursor = first.ok ? first.value.nextCursor : undefined;
      expect(await h.impl.listConversations(FAKE_USER_TOKEN, { limit: 2, cursor })).toEqual({
        ok: true,
        value: { channels: list.slice(2) },
      });
    });

    it.each([
      ["server_error", { kind: "upstream", service: "slack" }],
      ["rate_limited", { kind: "rate_limited" }],
      ["auth", { kind: "forbidden" }],
    ] as const)("a scripted %s fails exactly one call", async (kind, error) => {
      h.world.userToken(FAKE_USER_TOKEN);
      h.world.failNext(kind);
      expect(await h.impl.authTest(FAKE_USER_TOKEN)).toMatchObject({ ok: false, error });
      expect(await h.impl.authTest(FAKE_USER_TOKEN)).toMatchObject({ ok: true });
    });
  });
}
