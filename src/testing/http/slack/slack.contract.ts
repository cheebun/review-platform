import { describe, expect, it } from "vitest";
import type { SlackPort } from "../../../ports/slack";
import type { SlackWorld } from "./slack-world";

export type SlackHarness = { impl: SlackPort; world: SlackWorld; cleanup(): Promise<void> };

/** Runs against `FakeSlack` (unit) and `WebApiSlack` behind msw, so the fake stays honest. */
export function slackContract(make: () => Promise<SlackHarness>) {
  async function withHarness(fn: (h: SlackHarness) => Promise<void>) {
    const h = await make();
    try {
      await fn(h);
    } finally {
      await h.cleanup();
    }
  }

  describe("SlackPort contract", () => {
    it("authTest returns the user identity", () =>
      withHarness(async ({ impl }) => {
        const r = await impl.authTest();
        expect(r).toEqual({
          ok: true,
          value: {
            userId: "U1",
            teamId: "T1",
            teamUrl: "https://acme.slack.com/",
            teamName: "Acme",
            userName: "me",
            isBot: false,
          },
        });
      }));

    it("listConversations pages channels with name, privacy, archive and membership flags", () =>
      withHarness(async ({ impl, world }) => {
        world.seedChannelList([
          { id: "C1", name: "eng-review", isPrivate: false, isArchived: false, isMember: true },
          { id: "G2", name: "secret", isPrivate: true, isArchived: false, isMember: true },
          { id: "C3", name: "random", isPrivate: false, isArchived: false, isMember: false },
        ]);
        const first = await impl.listConversations({ limit: 2 });
        expect(first).toEqual({
          ok: true,
          value: {
            channels: [
              { id: "C1", name: "eng-review", isPrivate: false, isArchived: false, isMember: true },
              { id: "G2", name: "secret", isPrivate: true, isArchived: false, isMember: true },
            ],
            nextCursor: expect.any(String),
          },
        });
        const second = await impl.listConversations({
          limit: 2,
          cursor: first.ok ? first.value.nextCursor : undefined,
        });
        expect(second).toEqual({
          ok: true,
          value: {
            channels: [
              { id: "C3", name: "random", isPrivate: false, isArchived: false, isMember: false },
            ],
          },
        });
      }));

    it("listConversations maps an auth failure to forbidden", () =>
      withHarness(async ({ impl, world }) => {
        world.failNext("auth");
        expect(await impl.listConversations({})).toMatchObject({
          ok: false,
          error: { kind: "forbidden" },
        });
      }));

    describe("errors", () => {
      it("rate limiting maps to rate_limited with retry-after", () =>
        withHarness(async ({ impl, world }) => {
          world.failNext("rate_limited", { retryAfterS: 7 });
          const r = await impl.listConversations({});
          expect(r).toEqual({ ok: false, error: { kind: "rate_limited", retryAfterMs: 7000 } });
        }));

      it("auth errors map to forbidden", () =>
        withHarness(async ({ impl, world }) => {
          world.failNext("auth");
          const r = await impl.authTest();
          expect(!r.ok && r.error.kind).toBe("forbidden");
        }));

      it("5xx maps to a retryable upstream error", () =>
        withHarness(async ({ impl, world }) => {
          world.failNext("server_error");
          const r = await impl.authTest();
          expect(r).toEqual({
            ok: false,
            error: { kind: "upstream", service: "slack", retryable: true },
          });
        }));

      it("a failure fails exactly one call, and the next call succeeds", () =>
        withHarness(async ({ impl, world }) => {
          world.failNext("server_error");
          expect((await impl.authTest()).ok).toBe(false);
          expect((await impl.authTest()).ok).toBe(true);
        }));
    });
  });
}
