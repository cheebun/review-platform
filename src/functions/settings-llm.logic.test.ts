import { http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_KEY,
  ANTHROPIC_TOKEN,
  GATEWAY,
  llmSettingsSetup,
  OPENAI_KEY,
} from "../application/settings/llm-testing";
import { probeLlm } from "../adapters/llm/ping";
import type { Actor } from "../domain/shared/actor";
import { anthropicErrorResponse, anthropicStream } from "../testing/http/llm/anthropic";
import { server } from "../testing/http/server";
import {
  loadLlmSettings,
  parseAnthropicBody,
  parseLlmSectionBody,
  runRemoveLlmSection,
  runSaveAnthropic,
  runTestAnthropic,
  type LlmFnPorts,
} from "./settings-llm.logic";

const user: Actor = { kind: "user", userId: "u1", email: "a@example.com" };
const SECRETS = [ANTHROPIC_KEY, ANTHROPIC_TOKEN, OPENAI_KEY];
const expectNoSecretIn = (value: unknown) => {
  for (const secret of SECRETS) expect(JSON.stringify(value)).not.toContain(secret);
};

let s: ReturnType<typeof llmSettingsSetup>;
let ports: LlmFnPorts;
beforeEach(() => {
  // The real probe behind msw: request to stored settings, end to end.
  s = llmSettingsSetup((target) => probeLlm(target, { timeoutMs: 2_000 }));
  ports = s.deps;
});

const gateway = (respond: () => Response) =>
  server.use(http.post(`${GATEWAY}/v1/messages`, () => respond()));

describe("validators", () => {
  it("parseAnthropicBody keeps known, bounded fields only", () => {
    const body = {
      baseUrl: GATEWAY,
      model: "",
      apiKey: "k",
    };
    expect(parseAnthropicBody(body)).toEqual(body);
    for (const bad of [
      null,
      [],
      { ...body, extra: 1 },
      { ...body, apiKey: "x".repeat(2001) },
      { ...body, serverFallback: "yes" },
      { ...body, model: 3 },
    ]) {
      expect(() => parseAnthropicBody(bad)).toThrow();
    }
  });

  it("rejects the removed provider and obsolete configurable header/fallback fields", () => {
    expect(parseLlmSectionBody({ section: "anthropic" })).toEqual({ section: "anthropic" });
    expect(() => parseLlmSectionBody({ section: "openai" })).toThrow();
    expect(() => parseAnthropicBody({ authHeader: "bearer" })).toThrow();
    expect(() => parseAnthropicBody({ serverFallback: true })).toThrow();
  });

  it("a validator error never echoes the value", () => {
    let caught: unknown;
    try {
      parseAnthropicBody({ apiKey: ANTHROPIC_KEY, nope: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(ANTHROPIC_KEY);
  });
});

describe("running the use cases", () => {
  it("loads the view", async () => {
    expect(await loadLlmSettings(ports, user)).toMatchObject({
      ok: true,
      value: { availability: "not_configured" },
    });
  });

  it("a validation error carries its field and fixed message", async () => {
    const r = await runSaveAnthropic(ports, user, {
      apiKey: ANTHROPIC_KEY,
      authToken: ANTHROPIC_TOKEN,
    });
    expect(r).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "credential", requestId: expect.any(String) },
    });
    expectNoSecretIn(r);
  });

  it("rejected credentials land on the credential field", async () => {
    gateway(() => anthropicErrorResponse(401));
    const r = await runTestAnthropic(ports, user, { baseUrl: GATEWAY, apiKey: ANTHROPIC_KEY });
    expect(r).toMatchObject({ ok: false, error: { kind: "forbidden", field: "apiKey" } });
    expectNoSecretIn(r);
  });

  it("an unreachable endpoint is a retryable upstream error with no field", async () => {
    gateway(() => anthropicErrorResponse(502));
    const r = await runTestAnthropic(ports, user, { baseUrl: GATEWAY, apiKey: ANTHROPIC_KEY });
    expect(r).toMatchObject({ ok: false, error: { kind: "upstream" } });
    expect(r.ok === false && r.error.field).toBeFalsy();
  });

  it("saves, then removes a section", async () => {
    gateway(() => anthropicStream({ text: '{"ok":true}', stopReason: "end_turn" }));
    const saved = await runSaveAnthropic(ports, user, { baseUrl: GATEWAY, apiKey: ANTHROPIC_KEY });
    expect(saved).toMatchObject({ ok: true, value: { view: { active: "anthropic" } } });
    expect(s.probes).toHaveLength(0);
    expectNoSecretIn(saved);
    expect(await runRemoveLlmSection(ports, user, { section: "anthropic" })).toMatchObject({
      ok: true,
      value: { active: null },
    });
  });

  it("a thrown error is internal, logged by name only", async () => {
    const broken: LlmFnPorts = {
      ...ports,
      llmProbe: async () => {
        throw new Error(`boom ${OPENAI_KEY}`);
      },
    };
    const r = await runTestAnthropic(broken, user, { apiKey: ANTHROPIC_KEY });
    expect(r).toMatchObject({ ok: false, error: { kind: "internal" } });
    expectNoSecretIn(r);
    expectNoSecretIn(s.logger.entries);
  });
});
