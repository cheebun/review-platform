import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { err, ok } from "../../domain/shared/result";
import { server } from "../../testing/http/server";
import { SlackMessenger } from "./slack-messenger";

const TOKEN = "xoxp-0000-FAKE-messenger-token-0001";
const API = "https://slack.com/api/";

type Call = { method: string; auth: string; body: Record<string, string> };

function slackApi(answer: (method: string) => Response | Record<string, unknown>) {
  const calls: Call[] = [];
  server.use(
    http.post(`${API}:method`, async ({ request, params }) => {
      const method = String(params.method);
      const raw = await request.text();
      const type = request.headers.get("content-type") ?? "";
      const body = type.includes("json")
        ? (JSON.parse(raw) as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, auth: request.headers.get("authorization") ?? "", body });
      const out = answer(method);
      return out instanceof Response ? out : HttpResponse.json(out);
    }),
  );
  return calls;
}

const messenger = (token = async () => ok(TOKEN)) => new SlackMessenger(token, { timeoutMs: 500 });
const where = { channel: "C0REVIEW", ts: "1793757600.000100" };

describe("SlackMessenger", () => {
  it("replies in the thread as the owner, without unfurling", async () => {
    const calls = slackApi(() => ({ ok: true, channel: "C0REVIEW", ts: "1793757601.000100" }));
    const r = await messenger().reply({ channel: "C0REVIEW", threadTs: where.ts, text: "on it" });
    expect(r).toEqual(ok(undefined));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "chat.postMessage",
      auth: `Bearer ${TOKEN}`,
      body: { channel: "C0REVIEW", thread_ts: where.ts, text: "on it" },
    });
    expect(String(calls[0]!.body.unfurl_links)).toBe("false");
  });

  it("adds and removes reactions", async () => {
    const calls = slackApi(() => ({ ok: true }));
    expect(await messenger().add({ ...where, emoji: "hourglass_flowing_sand" })).toEqual(
      ok(undefined),
    );
    expect(await messenger().remove({ ...where, emoji: "red_circle" })).toEqual(ok(undefined));
    expect(calls.map((c) => [c.method, c.body.name, c.body.timestamp])).toEqual([
      ["reactions.add", "hourglass_flowing_sand", where.ts],
      ["reactions.remove", "red_circle", where.ts],
    ]);
  });

  it("already_reacted and no_reaction are success", async () => {
    slackApi((m) =>
      m === "reactions.add"
        ? { ok: false, error: "already_reacted" }
        : { ok: false, error: "no_reaction" },
    );
    expect(await messenger().add({ ...where, emoji: "large_green_circle" })).toEqual(ok(undefined));
    expect(await messenger().remove({ ...where, emoji: "large_green_circle" })).toEqual(
      ok(undefined),
    );
  });

  it("a 429 is rate_limited with its Retry-After", async () => {
    slackApi(() =>
      HttpResponse.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "Retry-After": "7" } },
      ),
    );
    expect(await messenger().add({ ...where, emoji: "red_circle" })).toEqual(
      err({ kind: "rate_limited", retryAfterMs: 7000 }),
    );
  });

  it("a deleted message is not_found", async () => {
    slackApi(() => ({ ok: false, error: "message_not_found" }));
    expect(await messenger().add({ ...where, emoji: "red_circle" })).toEqual(
      err({ kind: "not_found", entity: "slack" }),
    );
  });

  it("an unknown emoji name is a validation error", async () => {
    slackApi(() => ({ ok: false, error: "invalid_name" }));
    expect(await messenger().add({ ...where, emoji: "red_circle" })).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
  });

  it("without a stored user token nothing is sent", async () => {
    const calls = slackApi(() => ({ ok: true }));
    const none = new SlackMessenger(async () => err({ kind: "not_configured", feature: "slack" }));
    expect(await none.reply({ channel: "C0REVIEW", threadTs: where.ts, text: "x" })).toEqual(
      err({ kind: "not_configured", feature: "slack" }),
    );
    expect(calls).toEqual([]);
  });

  it("a throwing token source is a retryable upstream error", async () => {
    const broken = new SlackMessenger(async () => {
      throw new Error(`db down ${TOKEN}`);
    });
    const r = await broken.add({ ...where, emoji: "red_circle" });
    expect(r).toEqual(err({ kind: "upstream", service: "slack", retryable: true }));
  });

  it("an error never carries the token", async () => {
    slackApi(() => ({ ok: false, error: "invalid_auth" }));
    const r = await messenger().reply({ channel: "C0REVIEW", threadTs: where.ts, text: "x" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
