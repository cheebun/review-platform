import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../../testing/http/server";
import { OpenAiTool } from "./openai-structured";
import type { OpenAiAdapterOptions } from "./options";

// Test sentinels, never real credentials.
const KEY = "test-openai-credential-value";
const ENV_KEY = "test-env-openai-credential-leak";
const ENV_BASE = "https://env-leak.example.test/v1";
const OFFICIAL = "https://api.openai.com/v1";

const TOOL = {
  type: "function" as const,
  name: "submit",
  description: "d",
  parameters: { type: "object" },
  strict: false,
};

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function answer(base: string): Seen[] {
  const seen: Seen[] = [];
  server.use(
    http.post(`${base}/responses`, ({ request }) => {
      seen.push({ url: request.url, headers: Object.fromEntries(request.headers) });
      return HttpResponse.json({
        id: "resp_fixture_1",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        model: "gpt-6.1-sol",
        error: null,
        incomplete_details: null,
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "submit",
            arguments: "{}",
            status: "completed",
          },
        ],
        parallel_tool_calls: false,
        tool_choice: "auto",
        tools: [],
      });
    }),
  );
  return seen;
}

const send = (options: OpenAiAdapterOptions) =>
  new OpenAiTool({ maxRetries: 0, ...options }, { reasoningEffort: "low" }).call({
    input: "hi",
    tool: TOOL,
  });

describe("OpenAI endpoint and credentials never come from the environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("without a base URL, targets the official endpoint even when OPENAI_BASE_URL is set", async () => {
    vi.stubEnv("OPENAI_BASE_URL", ENV_BASE);
    const leaked = answer(ENV_BASE);
    const official = answer(OFFICIAL);
    const result = await send({ apiKey: KEY });
    expect(leaked).toHaveLength(0);
    expect(official).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("sends the configured key, never OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", ENV_KEY);
    const seen = answer(OFFICIAL);
    await send({ apiKey: KEY });
    expect(seen[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(seen[0]!.headers)).not.toContain(ENV_KEY);
  });

  it("does not pick up OPENAI_ORG_ID or OPENAI_PROJECT_ID headers", async () => {
    vi.stubEnv("OPENAI_ORG_ID", "org-env-leak");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-env-leak");
    const seen = answer(OFFICIAL);
    await send({ apiKey: KEY });
    expect(seen[0]!.headers["openai-organization"]).toBeUndefined();
    expect(seen[0]!.headers["openai-project"]).toBeUndefined();
  });

  it("a configured base URL wins, with its path prefix", async () => {
    vi.stubEnv("OPENAI_BASE_URL", ENV_BASE);
    const seen = answer("https://relay.example.test/v1");
    await send({ apiKey: KEY, baseURL: "https://relay.example.test/v1" });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).pathname).toBe("/v1/responses");
  });
});
