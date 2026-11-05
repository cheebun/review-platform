import { delay, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../../testing/http/server";
import { anthropicStream } from "../../testing/http/llm/anthropic";
import { AnthropicReviewer } from "./anthropic-reviewer";
import { OpenAiReviewer } from "./openai-reviewer";
import type { LlmCallOptions } from "./options";

// Test sentinels, never real credentials.
const ANTHROPIC = { apiKey: "test-anthropic-cancel-key", baseURL: "https://a.example.test" };
const OPENAI = { apiKey: "test-openai-cancel-key", baseURL: "https://o.example.test/v1" };
const ABORTED = { kind: "upstream", service: "llm", retryable: false };

const review = {
  owner: "o",
  repo: "r",
  number: 1,
  title: "t",
  body: "",
  author: "a",
  base: "main",
  head: "f",
  diffText: "diff",
};
type Call = (options: LlmCallOptions) => Promise<unknown>;
const calls: [string, Call][] = [
  ["anthropic reviewer", (o) => new AnthropicReviewer(ANTHROPIC).review(review, o)],
  ["openai reviewer", (o) => new OpenAiReviewer(OPENAI).review(review, o)],
];

/** Both endpoints hang until the test's signal aborts; returns the hit counter. */
function hang(): { hits: number } {
  const seen = { hits: 0 };
  const stall = async () => {
    seen.hits++;
    await delay("infinite");
    return anthropicStream({ text: "{}", stopReason: "end_turn" });
  };
  server.use(
    http.post(`${ANTHROPIC.baseURL}/v1/messages`, stall),
    http.post(`${OPENAI.baseURL}/responses`, stall),
  );
  return seen;
}

const TIMED_OUT = Symbol("timed out");
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))]);

describe.each(calls)("%s: AbortSignal", (_name, call) => {
  it("an already aborted signal sends nothing and fails closed", async () => {
    const seen = hang();
    const controller = new AbortController();
    controller.abort();
    const result = await within(call({ signal: controller.signal }), 2_000);
    expect(result).toEqual({ ok: false, error: ABORTED });
    expect(seen.hits).toBe(0);
  });

  it("aborting mid-request ends the call at once as a non-retryable upstream error", async () => {
    const seen = hang();
    const controller = new AbortController();
    const pending = call({ signal: controller.signal });
    await within(
      (async () => {
        while (seen.hits === 0) await new Promise((r) => setTimeout(r, 5));
      })(),
      2_000,
    );
    controller.abort();
    expect(await within(pending, 2_000)).toEqual({ ok: false, error: ABORTED });
  });
});
