import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../domain/shared/actor";
import type { FakeAuth } from "../testing/fakes/fake-auth";
import type { MemoryLogger } from "../testing/fakes/memory-logger";
import { createTestContainer } from "../testing/container";
import {
  MAX_LOGIN_TOKEN_INPUT,
  loadSetupStatus,
  parseLoginBody,
  parseRotateBody,
  runLoginWithToken,
  runRotateLoginToken,
  type LoginTokenFnPorts,
} from "./login-token.logic";

const TOKEN = "correct horse battery";
const NEW_TOKEN = "brand new token";
const IP = "203.0.113.9";
const USER: Actor = { kind: "user", userId: "owner", email: "owner@agent-ops.invalid" };
const headers = new Headers();

let ports: LoginTokenFnPorts;
let auth: FakeAuth;
let logger: MemoryLogger;

beforeEach(() => {
  const c = createTestContainer();
  ports = c.ports;
  auth = c.ports.auth as FakeAuth;
  logger = c.ports.logger as MemoryLogger;
});

/** Stores the token's hash as first-run setup does. */
async function initialize() {
  await ports.loginTokens.initialize(await ports.loginTokenHasher.hash(TOKEN));
}

describe("validators", () => {
  it("accept bounded strings and keep them verbatim (no trimming)", () => {
    expect(parseLoginBody({ token: "x" })).toEqual({ token: "x" });
    expect(parseRotateBody({ current: "a", token: "b", confirm: "b" })).toEqual({
      current: "a",
      token: "b",
      confirm: "b",
    });
  });

  it("reject other shapes and oversized payloads with a fixed message (never the input)", () => {
    const huge = "x".repeat(MAX_LOGIN_TOKEN_INPUT + 1);
    const cases: Array<[(i: unknown) => unknown, unknown]> = [
      [parseLoginBody, null],
      [parseLoginBody, { token: 123 }],
      [parseLoginBody, { token: huge }],
      [parseLoginBody, { token: TOKEN, redirect: "/" }],
      [parseRotateBody, { token: TOKEN, confirm: TOKEN }],
      [parseRotateBody, { current: huge, token: TOKEN, confirm: TOKEN }],
    ];
    for (const [parse, input] of cases) {
      let message = "";
      try {
        parse(input);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^Invalid [a-z ]+\.$/);
      expect(message).not.toContain(TOKEN);
    }
  });
});

describe("loadSetupStatus", () => {
  it("is { initialized } and switches after setup", async () => {
    expect(await loadSetupStatus(ports)).toEqual({ initialized: false });
    await initialize();
    expect(await loadSetupStatus(ports)).toEqual({ initialized: true });
  });
});

describe("runLoginWithToken", () => {
  it("is not_found (the client goes to /setup) before setup", async () => {
    const reply = await runLoginWithToken(ports, { token: TOKEN }, IP, headers);
    expect(reply.status).toBe(404);
    expect(reply.result).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });

  it("signs in with the right token", async () => {
    await initialize();
    expect(await runLoginWithToken(ports, { token: TOKEN }, IP, headers)).toEqual({
      result: { ok: true, value: null },
      status: 200,
    });
  });

  it("is a generic 401 for a wrong token, with no field hint", async () => {
    await initialize();
    const reply = await runLoginWithToken(ports, { token: "wrong-token" }, IP, headers);
    expect(reply.status).toBe(401);
    expect(reply.result).toEqual({
      ok: false,
      error: {
        kind: "unauthenticated",
        message: "Authentication is required.",
        requestId: expect.any(String),
      },
    });
  });

  it("is 429 with Retry-After and retryAfterSeconds after 5 failures", async () => {
    await initialize();
    for (let i = 0; i < 5; i++)
      await runLoginWithToken(ports, { token: "wrong-token" }, IP, headers);
    const reply = await runLoginWithToken(ports, { token: TOKEN }, IP, headers);
    expect(reply.status).toBe(429);
    expect(reply.headers).toEqual({ "Retry-After": "900" });
    expect(reply.result).toMatchObject({
      ok: false,
      error: { kind: "rate_limited", retryAfterSeconds: 900 },
    });
  });

  it("is a 500 internal error, logged without the token, when a port throws", async () => {
    await initialize();
    ports.attemptLimiter.attempt = async () => {
      throw new Error(`redis down while checking ${TOKEN}`);
    };
    const reply = await runLoginWithToken(ports, { token: TOKEN }, IP, headers);
    expect(reply.status).toBe(500);
    expect(reply.result).toMatchObject({ ok: false, error: { kind: "internal" } });
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
    expect(JSON.stringify(logger.entries)).not.toContain(TOKEN);
  });
});

describe("runRotateLoginToken", () => {
  beforeEach(async () => {
    await initialize();
  });

  it("rotates, revokes the sessions and clears the cookie", async () => {
    auth.addSession("s1", USER);
    const reply = await runRotateLoginToken(
      ports,
      USER,
      { current: TOKEN, token: NEW_TOKEN, confirm: NEW_TOKEN },
      IP,
      headers,
    );
    expect(reply).toEqual({ result: { ok: true, value: null }, status: 200 });
    expect(auth.sessionCount).toBe(0);
    expect(auth.cookieClears).toBe(1);
    expect((await runLoginWithToken(ports, { token: TOKEN }, IP, headers)).status).toBe(401);
    expect((await runLoginWithToken(ports, { token: NEW_TOKEN }, IP, headers)).status).toBe(200);
  });

  it("reports a wrong current token on the current field", async () => {
    const reply = await runRotateLoginToken(
      ports,
      USER,
      { current: "wrong-token", token: NEW_TOKEN, confirm: NEW_TOKEN },
      IP,
      headers,
    );
    expect(reply.status).toBe(400);
    expect(reply.result).toMatchObject({ ok: false, error: { field: "current" } });
  });
});
