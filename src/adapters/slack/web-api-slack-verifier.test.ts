import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  FAKE_USER_TOKEN,
  slackVerifierContract,
} from "../../testing/contracts/slack-verifier.contract";
import { server } from "../../testing/http/server";
import { createSlackVerifierMsw } from "../../testing/http/slack/slack-verifier-msw";
import { WebApiSlackVerifier } from "./web-api-slack-verifier";

slackVerifierContract(async () => ({
  impl: new WebApiSlackVerifier(),
  world: createSlackVerifierMsw(),
  cleanup: async () => {},
}));

describe("WebApiSlackVerifier", () => {
  it("sends the candidate token in the Authorization header, never in the body", async () => {
    let auth = "";
    let body = "";
    server.use(
      http.post("https://slack.com/api/auth.test", async ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        body = await request.text();
        return HttpResponse.json({ ok: true, user_id: "U1", team_id: "T1", team: "Acme" });
      }),
    );
    expect(await new WebApiSlackVerifier().authTest(FAKE_USER_TOKEN)).toMatchObject({ ok: true });
    expect(auth).toBe(`Bearer ${FAKE_USER_TOKEN}`);
    expect(body).not.toContain(FAKE_USER_TOKEN);
  });

  it("times out as a retryable upstream error", async () => {
    server.use(
      http.post("https://slack.com/api/conversations.list", async () => {
        await delay(500);
        return HttpResponse.json({ ok: true, channels: [] });
      }),
    );
    const r = await new WebApiSlackVerifier({ timeoutMs: 50 }).listConversations(
      FAKE_USER_TOKEN,
      {},
    );
    expect(r).toEqual({
      ok: false,
      error: { kind: "upstream", service: "slack", retryable: true },
    });
  });

  it("an error result never carries the token", async () => {
    server.use(
      http.post("https://slack.com/api/auth.test", () =>
        HttpResponse.json({ ok: false, error: "invalid_auth" }),
      ),
    );
    const r = await new WebApiSlackVerifier().authTest(FAKE_USER_TOKEN);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(FAKE_USER_TOKEN);
  });
});
