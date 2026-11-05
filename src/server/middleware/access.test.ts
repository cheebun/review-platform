import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { decideAccess, isGuardedPath, type AccessInput } from "./access";

const USER: Actor = { kind: "user", userId: "u1", email: "a@b.c" };
const UNAUTH: Result<Actor, DomainError> = err({ kind: "unauthenticated" });

function input(over: Partial<AccessInput> = {}): AccessInput {
  return {
    pathname: "/api/me",
    method: "GET",
    handlerType: "router",
    headers: new Headers(),
    resolve: vi.fn(async () => ok(USER)),
    newRequestId: () => "req-1",
    logger: new MemoryLogger(),
    ...over,
  };
}

describe("isGuardedPath", () => {
  it.each([
    ["/api/me", "router"],
    ["/api", "router"],
    ["/api/", "router"],
    ["/API/me", "router"],
    ["/api//me", "router"],
    ["/%61pi/me", "router"],
    ["/api/auth/x", "router"],
    ["/x/../api/me", "router"],
    ["/api\\me", "router"],
    ["/%zz", "router"],
    ["/anything", "serverFn"],
    ["/_serverFn/abc", "serverFn"],
  ] as const)("%s (%s) is guarded", (pathname, handlerType) => {
    expect(isGuardedPath(pathname, handlerType)).toBe(true);
  });

  it.each(["/", "/login", "/review", "/apix", "/assets/app.js", "/login/api"])(
    "page path %s is not guarded",
    (pathname) => {
      expect(isGuardedPath(pathname, "router")).toBe(false);
    },
  );
});

describe("decideAccess", () => {
  it("skips pages: no actor resolution at all", async () => {
    const i = input({ pathname: "/login" });
    expect(await decideAccess(i)).toEqual({ kind: "skip" });
    expect(i.resolve).not.toHaveBeenCalled();
  });

  it("skips public API paths without resolving", async () => {
    for (const [pathname, method] of [
      ["/api/auth/sign-in/email", "POST"],
      ["/api/auth/get-session", "GET"],
      ["/api/slack/events", "POST"],
    ] as const) {
      const i = input({ pathname, method });
      expect(await decideAccess(i)).toEqual({ kind: "skip" });
      expect(i.resolve).not.toHaveBeenCalled();
    }
  });

  it("passes the resolved actor for a protected API path", async () => {
    const i = input();
    expect(await decideAccess(i)).toEqual({ kind: "actor", actor: USER });
    expect(i.resolve).toHaveBeenCalledWith(i.headers);
  });

  it("a server function request requires an actor even though it is not under /api", async () => {
    const i = input({ pathname: "/_serverFn/abc", method: "POST", handlerType: "serverFn" });
    expect(await decideAccess(i)).toEqual({ kind: "actor", actor: USER });
    const denied = await decideAccess(
      input({ handlerType: "serverFn", resolve: async () => UNAUTH }),
    );
    expect(denied).toMatchObject({ kind: "reject", http: { status: 401 } });
  });

  it("unauthenticated protected request: 401 body from toHttp with a fresh request id", async () => {
    const ids = ["r1", "r2"];
    const mk = () => input({ resolve: async () => UNAUTH, newRequestId: () => ids.shift()! });
    const a = await decideAccess(mk());
    expect(a).toEqual({
      kind: "reject",
      http: {
        status: 401,
        body: { kind: "unauthenticated", message: "Authentication is required.", requestId: "r1" },
      },
    });
    expect(await decideAccess(mk())).toMatchObject({ http: { body: { requestId: "r2" } } });
  });

  it("an unknown protected API path with no actor is 401, not 404", async () => {
    const d = await decideAccess(input({ pathname: "/api/nope", resolve: async () => UNAUTH }));
    expect(d).toMatchObject({ kind: "reject", http: { status: 401 } });
  });

  it("an unexpected resolver failure is a generic 500 and is logged, not leaked", async () => {
    const logger = new MemoryLogger();
    const d = await decideAccess(
      input({
        logger,
        resolve: async () => {
          throw new Error("db password=hunter2 exploded");
        },
      }),
    );
    expect(d).toMatchObject({
      kind: "reject",
      http: { status: 500, body: { kind: "internal", requestId: "req-1" } },
    });
    expect(JSON.stringify(d)).not.toContain("hunter2");
    expect(logger.entries[0]).toMatchObject({
      level: "error",
      fields: { requestId: "req-1", error: "Error" },
    });
    // The error's own message can carry SQL parameters or credentials; it is never logged.
    expect(JSON.stringify(logger.entries)).not.toContain("hunter2");
  });

  it("a malformed path that is under /api in disguise still requires auth", async () => {
    const d = await decideAccess(
      input({ pathname: "/api/auth/../execute", resolve: async () => UNAUTH }),
    );
    expect(d).toMatchObject({ kind: "reject", http: { status: 401 } });
  });
});
