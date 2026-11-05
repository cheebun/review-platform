import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { WebClient } from "@slack/web-api";
import { http, HttpResponse } from "msw";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { server } from "../../src/testing/http/server";

/** Records every request that reaches the msw handler, and proves fetch never fell through. */
function hit(method: "get" | "post", url: string, body: unknown) {
  const seen: string[] = [];
  server.use(
    http[method](url, ({ request }) => {
      seen.push(new URL(request.url).host);
      return HttpResponse.json(body as Record<string, unknown>);
    }),
  );
  return seen;
}

describe("msw intercepts every external client", () => {
  it("Octokit (api.github.com)", async () => {
    const seen = hit("get", "https://api.github.com/repos/o/r", { full_name: "o/r" });
    const res = await new Octokit().rest.repos.get({ owner: "o", repo: "r" });
    expect(res.data.full_name).toBe("o/r");
    expect(seen).toEqual(["api.github.com"]);
  });

  it("@slack/web-api WebClient (slack.com)", async () => {
    const seen = hit("post", "https://slack.com/api/auth.test", { ok: true, user_id: "U1" });
    const res = await new WebClient("xoxb-test", { retryConfig: { retries: 0 } }).auth.test();
    expect(res.user_id).toBe("U1");
    expect(seen).toEqual(["slack.com"]);
  });

  it("@anthropic-ai/sdk (api.anthropic.com)", async () => {
    const seen = hit("post", "https://api.anthropic.com/v1/messages", {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const client = new Anthropic({
      apiKey: "test",
      baseURL: "https://api.anthropic.com",
      maxRetries: 0,
    });
    const res = await client.messages.create({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.id).toBe("msg_1");
    expect(seen).toEqual(["api.anthropic.com"]);
  });

  it("openai (api.openai.com)", async () => {
    const seen = hit("post", "https://api.openai.com/v1/chat/completions", {
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
    });
    const client = new OpenAI({
      apiKey: "test",
      baseURL: "https://api.openai.com/v1",
      maxRetries: 0,
    });
    const res = await client.chat.completions.create({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.id).toBe("c1");
    expect(seen).toEqual(["api.openai.com"]);
  });

  it("plain fetch", async () => {
    const seen = hit("get", "https://service.example.test/items/1", {
      key: "item-1",
    });
    const res = await fetch("https://service.example.test/items/1");
    expect(await res.json()).toEqual({ key: "item-1" });
    expect(seen).toEqual(["service.example.test"]);
  });

  it("an unhandled external request rejects visibly and never reaches the network", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A silent 500 response is not acceptable: fetch itself must reject.
    await expect(fetch("https://api.github.com/zen")).rejects.toThrow();
    error.mockRestore();
    warn.mockRestore();
  });
});
