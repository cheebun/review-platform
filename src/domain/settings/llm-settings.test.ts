import { describe, expect, it } from "vitest";
import {
  classifyProbe,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  LLM_MODEL_MAX_LENGTH,
  parseAnthropicSettings,
  parseLlmBaseUrl,
  parseLlmModel,
  parseLlmSecret,
  readAnthropicStored,
  selectLlmProvider,
  toLlmCredentialView,
} from "./llm-settings";

// Test sentinels, never real credentials.
const KEY = "test-llm-key-0000-FAKE-abcd";
const TOKEN = "test-llm-token-0000-FAKE-wxyz";

const field = (r: { ok: boolean; error?: unknown }) =>
  r.ok ? null : (r.error as { kind: string; field?: string });

describe("defaults", () => {
  it("Anthropic defaults to claude-opus-5-5; OpenAI keeps the config default", () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-opus-5-5");
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-6.1-sol");
  });
});

describe("parseLlmBaseUrl", () => {
  it("empty or absent means the official endpoint (null)", () => {
    for (const v of [undefined, null, "", "   "]) {
      expect(parseLlmBaseUrl(v, "baseUrl")).toEqual({ ok: true, value: null });
    }
  });

  it("accepts http and https, lower-cases the host and drops trailing slashes", () => {
    expect(parseLlmBaseUrl(" https://LLM.Example.test/gateway// ", "baseUrl")).toEqual({
      ok: true,
      value: "https://llm.example.test/gateway",
    });
    expect(parseLlmBaseUrl("http://127.0.0.1:8080/", "baseUrl")).toEqual({
      ok: true,
      value: "http://127.0.0.1:8080",
    });
  });

  it.each([
    "ftp://llm.example.test",
    "llm.example.test",
    "https://user:pass@llm.example.test",
    "https://user@llm.example.test",
    "https://llm.example.test/?token=abc",
    "https://llm.example.test/#frag",
    "javascript:alert(1)",
    `https://llm.example.test/${"a".repeat(2100)}`,
    42,
  ])("rejects %s on its field, without echoing it", (input) => {
    const r = parseLlmBaseUrl(input, "baseUrl");
    expect(r.ok).toBe(false);
    expect(field(r)).toMatchObject({ kind: "validation", field: "baseUrl" });
    expect(JSON.stringify(r)).not.toContain("pass");
  });
});

describe("parseLlmModel", () => {
  it("empty means the default (null); a name is trimmed", () => {
    expect(parseLlmModel("", "model")).toEqual({ ok: true, value: null });
    expect(parseLlmModel(undefined, "model")).toEqual({ ok: true, value: null });
    expect(parseLlmModel(" claude-sonnet-5-5 ", "model")).toEqual({
      ok: true,
      value: "claude-sonnet-5-5",
    });
    expect(parseLlmModel("openrouter/anthropic/claude-4.5:beta", "model").ok).toBe(true);
  });

  it("is capped and rejects spaces and control characters", () => {
    expect(parseLlmModel("m".repeat(LLM_MODEL_MAX_LENGTH), "model").ok).toBe(true);
    for (const bad of ["m".repeat(LLM_MODEL_MAX_LENGTH + 1), "a b", "a\nb", "-x", 7]) {
      expect(field(parseLlmModel(bad, "model"))).toMatchObject({ field: "model" });
    }
  });
});

describe("parseLlmSecret", () => {
  it("trims a pasted newline", () => {
    expect(parseLlmSecret(`${KEY}\n`, "apiKey")).toEqual({ ok: true, value: KEY });
  });

  it("rejects short, spaced or non-string values with a fixed message", () => {
    for (const bad of ["short", `${KEY} x`, "", 5]) {
      const r = parseLlmSecret(bad, "apiKey");
      expect(field(r)).toMatchObject({ kind: "validation", field: "apiKey" });
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });
});

describe("parseAnthropicSettings", () => {
  const base = { baseUrl: "", model: "" };

  it("an API key, the defaults left empty", () => {
    expect(parseAnthropicSettings({ ...base, apiKey: KEY })).toEqual({
      ok: true,
      value: {
        baseUrl: null,
        model: null,
        credential: { kind: "api_key", value: KEY },
      },
    });
  });

  it("an auth token, or no new credential (keep the stored one)", () => {
    const t = parseAnthropicSettings({ ...base, authToken: TOKEN });
    expect(t.ok && t.value.credential).toEqual({ kind: "auth_token", value: TOKEN });
    const none = parseAnthropicSettings({ ...base, apiKey: "", authToken: "" });
    expect(none.ok && none.value.credential).toBeNull();
  });

  it("exactly one: both an API key and an auth token is rejected", () => {
    const r = parseAnthropicSettings({ ...base, apiKey: KEY, authToken: TOKEN });
    expect(field(r)).toMatchObject({ kind: "validation", field: "credential" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("bad URL and model land on their fields", () => {
    expect(
      field(parseAnthropicSettings({ ...base, baseUrl: "ftp://x", apiKey: KEY })),
    ).toMatchObject({ field: "baseUrl" });
    expect(field(parseAnthropicSettings({ ...base, model: "a b", apiKey: KEY }))).toMatchObject({
      field: "model",
    });
  });
});

describe("classifyProbe", () => {
  it("ok is verified", () => {
    expect(classifyProbe({ kind: "ok", latencyMs: 5, model: "m" })).toBe("verified");
  });

  it("401 and 403 reject the credentials", () => {
    expect(classifyProbe({ kind: "error", latencyMs: 5, status: 401 })).toBe("rejected");
    expect(classifyProbe({ kind: "error", latencyMs: 5, status: 403 })).toBe("rejected");
  });

  it("network, timeout, 408, 429 and 5xx: unreachable (still saves nothing)", () => {
    for (const status of [undefined, 408, 429, 500, 502, 529]) {
      expect(classifyProbe({ kind: "error", latencyMs: 5, status })).toBe("unreachable");
    }
  });

  it("any other 4xx means the endpoint refused the request (wrong URL or model)", () => {
    for (const status of [400, 404, 422]) {
      expect(classifyProbe({ kind: "error", latencyMs: 5, status })).toBe("refused");
    }
  });
});

const s = (a: string, t: string, o: string) =>
  selectLlmProvider({
    anthropic_api_key: a,
    anthropic_auth_token: t,
    openai_api_key: o,
  } as never);

describe("selectLlmProvider (no runtime fallback)", () => {
  it("Anthropic if configured; obsolete OpenAI secrets are ignored", () => {
    expect(s("ready", "not_configured", "ready")).toEqual({ provider: "anthropic" });
    expect(s("not_configured", "ready", "not_configured")).toEqual({ provider: "anthropic" });
    expect(s("not_configured", "not_configured", "ready")).toEqual({
      provider: null,
      reason: "not_configured",
    });
    expect(s("not_configured", "not_configured", "not_configured")).toEqual({
      provider: null,
      reason: "not_configured",
    });
  });

  it("an undecryptable secret of the chosen provider is needs_reset, never a silent switch", () => {
    expect(s("needs_reset", "not_configured", "ready")).toEqual({
      provider: null,
      reason: "needs_reset",
    });
    expect(s("not_configured", "not_configured", "needs_reset")).toEqual({
      provider: null,
      reason: "not_configured",
    });
  });
});

describe("stored values are re-checked on read", () => {
  it("anthropic: endpoint and runtime model defaults", () => {
    expect(readAnthropicStored({})).toEqual({
      ok: true,
      value: {
        baseUrl: null,
        model: DEFAULT_ANTHROPIC_MODEL,
      },
    });
    expect(readAnthropicStored({ anthropic_base_url: "https://llm.example.test" })).toMatchObject({
      ok: true,
      value: { baseUrl: "https://llm.example.test" },
    });
  });

  it("a tampered Anthropic endpoint fails closed", () => {
    expect(readAnthropicStored({ anthropic_base_url: "ftp://x" }).ok).toBe(false);
  });
});

describe("toLlmCredentialView", () => {
  const meta = {
    last4: "abcd",
    savedAt: new Date("2026-11-04T03:00:00.000Z"),
    verifiedAt: null,
    testResult: { model: "claude-opus-5-5", latencyMs: 321, secret: "never" },
  };

  it("unset, set (with the probe facts) and needs_reset; never anything else", () => {
    expect(toLlmCredentialView({ state: "not_configured" })).toEqual({ state: "unset" });
    expect(toLlmCredentialView({ state: "ready", meta })).toEqual({
      state: "set",
      last4: "abcd",
      savedAt: "2026-11-04T03:00:00.000Z",
      verifiedAt: null,
      model: "claude-opus-5-5",
      latencyMs: 321,
    });
    expect(toLlmCredentialView({ state: "needs_reset", meta })).toMatchObject({
      state: "needs_reset",
    });
    expect(JSON.stringify(toLlmCredentialView({ state: "ready", meta }))).not.toContain("never");
  });
});
