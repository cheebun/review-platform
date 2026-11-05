import { http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../../testing/http/server";
import { anthropicStream } from "../../testing/http/llm/anthropic";
import { AnthropicStructured, buildAnthropicClientOptions } from "./anthropic-structured";
import type { AnthropicAdapterOptions } from "./options";

const BASE = "https://llm.example.test";
const SECRET = "test-credential-value";
const request = {
  messages: [{ role: "user" as const, content: "hi" }],
  schema: { type: "object" },
};

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Answers `POST <base>/v1/messages` and records exactly what the adapter sent. */
function capture(base: string): Seen[] {
  const seen: Seen[] = [];
  server.use(
    http.post(`${base}/v1/messages`, async ({ request: req }) => {
      seen.push({
        url: req.url,
        headers: Object.fromEntries(req.headers),
        body: (await req.json()) as Record<string, unknown>,
      });
      return anthropicStream({ text: "{}", stopReason: "end_turn" });
    }),
  );
  return seen;
}

async function send(options: AnthropicAdapterOptions) {
  const llm = new AnthropicStructured({ maxRetries: 0, ...options }, "low");
  return llm.call(request);
}

describe("Anthropic custom endpoint", () => {
  it("sends to the custom base URL, host and path", async () => {
    const seen = capture(BASE);
    const result = await send({ baseURL: BASE, apiKey: SECRET });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).origin + new URL(seen[0]!.url).pathname).toBe(
      `${BASE}/v1/messages`,
    );
  });

  it("keeps a path prefix of the base URL", async () => {
    const seen = capture(`${BASE}/gateway`);
    await send({ baseURL: `${BASE}/gateway`, apiKey: SECRET });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).pathname).toBe("/gateway/v1/messages");
  });

  it("API key derives x-api-key: exactly x-api-key and no Authorization", async () => {
    const seen = capture(BASE);
    await send({ baseURL: BASE, apiKey: SECRET });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["x-api-key"]).toBe(SECRET);
    expect(seen[0]!.headers["authorization"]).toBeUndefined();
  });

  it("auth token: Authorization Bearer and no x-api-key", async () => {
    const seen = capture(BASE);
    await send({ baseURL: BASE, authToken: SECRET });
    expect(seen[0]!.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("runtime requests: no anthropic-beta header and no betas/fallbacks in the body", async () => {
    const seen = capture(BASE);
    await send({ baseURL: BASE, apiKey: SECRET });
    expect(seen[0]!.headers["anthropic-beta"]).toBeUndefined();
    expect(seen[0]!.body).not.toHaveProperty("betas");
    expect(seen[0]!.body).not.toHaveProperty("fallbacks");
  });

  describe("without a configured base URL", () => {
    // The SDK reads ANTHROPIC_BASE_URL from process.env when `baseURL` is undefined. A developer
    // shell (or a gateway setup) often sets it to a loopback proxy, which the msw setup lets
    // through: the old test then made a real, slow LLM call and timed out.
    const ENV_BASE = "https://env-leak.example.test";
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("targets api.anthropic.com explicitly: process.env ANTHROPIC_BASE_URL is never read", async () => {
      vi.stubEnv("ANTHROPIC_BASE_URL", ENV_BASE);
      expect(buildAnthropicClientOptions({ apiKey: SECRET }).baseURL).toBe(
        "https://api.anthropic.com",
      );
      const leaked = capture(ENV_BASE);
      const result = await send({ apiKey: SECRET });
      expect(leaked).toHaveLength(0);
      expect(result.ok).toBe(false);
    });

    it("does not leak a request to api.anthropic.com: it stays unhandled and fails closed", async () => {
      vi.stubEnv("ANTHROPIC_BASE_URL", ENV_BASE);
      const seen = capture(BASE);
      const leaked = capture(ENV_BASE);
      const result = await send({ apiKey: SECRET });
      expect(result).toEqual({
        ok: false,
        error: { kind: "upstream", service: "llm", retryable: true },
      });
      expect(seen).toHaveLength(0);
      expect(leaked).toHaveLength(0);
    });
  });
});
