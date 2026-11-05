import { describe, expect, it } from "vitest";
import { createSlackMsw } from "../../testing/http/slack/slack-msw";
import { slackContract } from "../../testing/http/slack/slack.contract";
import { WebApiSlack } from "./web-api-slack";

slackContract(async () => ({
  impl: new WebApiSlack({ token: "xoxp-fake-token-000" }),
  world: createSlackMsw(),
  cleanup: async () => {},
}));

describe("WebApiSlack", () => {
  it("authTest flags a bot token so callers can refuse it", async () => {
    const { http, HttpResponse } = await import("msw");
    const { server } = await import("../../testing/http/server");
    server.use(
      http.post("https://slack.com/api/auth.test", () =>
        HttpResponse.json({ ok: true, user_id: "U1", team_id: "T1", bot_id: "B1", url: "u/" }),
      ),
    );
    const r = await new WebApiSlack({ token: "xoxb-fake" }).authTest();
    expect(r.ok && r.value.isBot).toBe(true);
  });

  it("times out as a retryable upstream error", async () => {
    const { http, HttpResponse, delay } = await import("msw");
    const { server } = await import("../../testing/http/server");
    server.use(
      http.post("https://slack.com/api/conversations.list", async () => {
        await delay(500);
        return HttpResponse.json({ ok: true, channels: [] });
      }),
    );
    const r = await new WebApiSlack({ token: "xoxp-fake", timeoutMs: 50 }).listConversations({});
    expect(r).toEqual({
      ok: false,
      error: { kind: "upstream", service: "slack", retryable: true },
    });
  });
});
