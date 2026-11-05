import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { AnthropicTarget } from "../../domain/settings/llm-settings";
import { InMemorySettingsStore } from "../../testing/fakes/in-memory-settings-store";
import { server } from "../../testing/http/server";
import { anthropicErrorResponse } from "../../testing/http/llm/anthropic";
import {
  formatPingReport,
  probeLlm,
  runAnthropicPing,
  runLlmPingFromSettings,
  type PingReport,
} from "./ping";

const KEY = "sk-ant-secret-value-123456789012345";
const report = (over: Partial<PingReport> = {}): PingReport => ({
  provider: "anthropic",
  baseUrl: "https://llm.example.test",
  model: "claude-opus-5-5",
  authHeader: "x-api-key",
  latencyMs: 123.456,
  outcome: { kind: "ok", status: 200 },
  ...over,
});

describe("formatPingReport", () => {
  it("prints provider, host, model, header mode, status, latency and a fixed ok", () => {
    expect(formatPingReport(report())).toBe(
      [
        "provider: anthropic",
        "host: llm.example.test",
        "model: claude-opus-5-5",
        "auth header: x-api-key",
        "status: 200",
        "result: ok",
        "latency: 123 ms",
      ].join("\n"),
    );
  });

  it("prints only the host of a URL that has credentials, a path and a query", () => {
    const out = formatPingReport(
      report({
        baseUrl: "https://user:hunter2@llm.example.test:8443/v1/private-path?token=abc#frag",
      }),
    );
    expect(out).toContain("host: llm.example.test:8443");
    for (const leak of ["hunter2", "user:", "private-path", "token", "abc", "frag", "/v1"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("names the default host when no base URL is set, and never echoes an unparsable one", () => {
    expect(formatPingReport(report({ baseUrl: undefined }))).toContain(
      "host: api.anthropic.com (default)",
    );
    const out = formatPingReport(report({ baseUrl: "not a url sk-secret" }));
    expect(out).toContain("host: (invalid)");
    expect(out).not.toContain("sk-secret");
  });

  it("prints the mapped error kind and status, and nothing else from the error", () => {
    const error = {
      kind: "upstream",
      service: "llm",
      retryable: false,
      message: `Authorization: Bearer ${KEY}`,
      body: "response body text",
    } as never;
    const out = formatPingReport(report({ outcome: { kind: "error", error, status: 401 } }));
    expect(out).toContain("status: 401");
    expect(out).toContain("result: error upstream (retryable: false)");
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("response body");
    expect(out).not.toContain("result: ok");
  });

  it("prints no status line for an error without an HTTP status", () => {
    const out = formatPingReport(
      report({
        outcome: { kind: "error", error: { kind: "upstream", service: "llm", retryable: true } },
      }),
    );
    expect(out).toContain("status: none");
  });

  it("strips control characters from the model name", () => {
    const out = formatPingReport(report({ model: `m\nresult: ok\u001b[31m` }));
    expect(out.split("\n")).toHaveLength(7);
  });
});

const reply = () =>
  HttpResponse.json({
    id: "msg_probe",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: "Hi!" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 2 },
  });

describe("Anthropic credential probes", () => {
  const target: AnthropicTarget = {
    provider: "anthropic",
    baseUrl: "https://llm.example.test",
    model: "configured-runtime-model",
    credential: { kind: "api_key", value: KEY },
  };

  it.each(["api_key", "auth_token"] as const)(
    "uses the exact greeting and fixed model with derived %s headers",
    async (kind) => {
      const seen: { body: Record<string, any>; headers: Headers }[] = [];
      server.use(
        http.post("https://llm.example.test/v1/messages", async ({ request }) => {
          seen.push({
            body: (await request.json()) as Record<string, any>,
            headers: request.headers,
          });
          return reply();
        }),
      );
      const outcome = await probeLlm({ ...target, credential: { kind, value: KEY } });
      expect(outcome).toMatchObject({ kind: "ok", model: "claude-haiku-5-5" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).toEqual({
        model: "claude-haiku-5-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi!" }],
        output_config: { effort: "low" },
      });
      expect(seen[0]!.headers.get("anthropic-beta")).toBeNull();
      if (kind === "api_key") {
        expect(seen[0]!.headers.get("x-api-key")).toBe(KEY);
        expect(seen[0]!.headers.get("authorization")).toBeNull();
      } else {
        expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
        expect(seen[0]!.headers.get("x-api-key")).toBeNull();
      }
      expect(target.model).toBe("configured-runtime-model");
    },
  );

  it.each([401, 403, 404, 429, 500])("reports HTTP %i without retries", async (status) => {
    let hits = 0;
    server.use(
      http.post("https://llm.example.test/v1/messages", () => {
        hits++;
        return anthropicErrorResponse(status);
      }),
    );
    expect(await probeLlm(target)).toMatchObject({ kind: "error", status });
    expect(hits).toBe(1);
  });

  it("contains client construction failures without exposing credentials", async () => {
    const result = await probeLlm(
      target,
      {},
      {
        clientFactory: () => {
          throw new Error(KEY);
        },
      },
    );
    expect(result).toMatchObject({ kind: "error" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("bounds a nonresponding endpoint with the configured timeout", async () => {
    server.use(
      http.post("https://llm.example.test/v1/messages", async () => {
        await delay("infinite");
        return reply();
      }),
    );
    const started = Date.now();
    const r = await probeLlm(target, { timeoutMs: 100 });
    expect(r.kind).toBe("error");
    expect(r).not.toHaveProperty("status");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the low-level ping also overrides an explicitly configured runtime model", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post("https://llm.example.test/v1/messages", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return reply();
      }),
    );
    expect(
      await runAnthropicPing({
        apiKey: KEY,
        baseURL: target.baseUrl!,
        model: "expensive-runtime-model",
      }),
    ).toMatchObject({ outcome: { kind: "ok" } });
    expect(body.model).toBe("claude-haiku-5-5");
  });

  it("the CLI uses the same fixed model and preserves stored runtime settings", async () => {
    const store = new InMemorySettingsStore();
    const at = new Date();
    const event = () => ({
      id: "e",
      type: "settings_value_saved" as const,
      actor: { kind: "user" as const, id: "u1" },
      at,
    });
    await store.saveSecret(
      "anthropic_api_key",
      { value: KEY, savedAt: at, savedByUserId: "u1", verifiedAt: null, testResult: null },
      event,
    );
    await store.saveValues(
      { anthropic_base_url: target.baseUrl!, anthropic_model: target.model },
      { at, by: "u1", event },
    );
    let body: Record<string, unknown> = {};
    server.use(
      http.post("https://llm.example.test/v1/messages", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return reply();
      }),
    );
    expect(await runLlmPingFromSettings(store)).toMatchObject({
      kind: "report",
      report: { model: "claude-haiku-5-5", outcome: { kind: "ok" } },
    });
    expect(body.model).toBe("claude-haiku-5-5");
    expect(await store.getValues(["anthropic_model"])).toEqual({ anthropic_model: target.model });
  });

  it("nothing stored: no request", async () => {
    expect(await runLlmPingFromSettings(new InMemorySettingsStore())).toEqual({
      kind: "not_configured",
      reason: "not_configured",
    });
  });
});
