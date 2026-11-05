import { createRequire } from "node:module";
import { isRedirect, redirect as toRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../domain/shared/actor";

/**
 * The exact seroval build the router serializes with. It is not a direct dependency of the app,
 * so it is resolved through `@tanstack/react-router` -> `@tanstack/router-core`.
 */
const routerCore = createRequire(
  createRequire(import.meta.url).resolve("@tanstack/react-router"),
).resolve("@tanstack/router-core");
const { toJSONAsync, fromJSON } = (await import(createRequire(routerCore).resolve("seroval"))) as {
  toJSONAsync: (value: unknown, options?: { plugins?: unknown[] }) => Promise<unknown>;
  fromJSON: (value: unknown, options?: { plugins?: unknown[] }) => unknown;
};
/** The plugins Start serializes a server function's thrown error with (`ShallowErrorPlugin`, ...). */
const { defaultSerovalPlugins } = (await import(
  createRequire(routerCore).resolve("@tanstack/router-core/ssr/client")
)) as { defaultSerovalPlugins: unknown[] };

/** What the browser's `serverFnFetcher` ends up throwing for a serialized `{ error }`. */
async function overTheWire(error: unknown): Promise<{ json: string; error: unknown }> {
  const json = await toJSONAsync({ error }, { plugins: defaultSerovalPlugins });
  const back = fromJSON(json, { plugins: defaultSerovalPlugins }) as { error: unknown };
  return { json: JSON.stringify(json), error: back.error };
}

const INTERNAL_DETAIL = "relation users: password=hunter2";

const USER: Actor = { kind: "user", userId: "u1", email: "a@b.c" };
const VALID_COOKIE = "session=valid";

const state = vi.hoisted(() => ({ request: new Request("http://app.test/") }));

vi.mock("../runtime", () => ({
  getContainer: async () => ({
    ports: {
      auth: {
        getSessionActor: async (headers: Headers) => {
          if (headers.get("cookie") === "session=boom") {
            throw new Error("relation users: password=hunter2");
          }
          return headers.get("cookie") === "session=valid"
            ? { kind: "user", userId: "u1", email: "a@b.c" }
            : null;
        },
      },
    },
  }),
  // A deployment that still sets the former MACHINE_TOKEN: it must grant nothing.
  getConfig: async () => ({ machineToken: "m".repeat(40) }),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => state.request,
}));

const { accessMiddleware, authed, publicFn, publicServerFnGate } =
  await import("./auth-middleware");
const { AnonymousCall } = await import("./anonymous-call");
const { ServerFnError, parseServerFnError } = await import("./server-fn-error");

type ServerFn = (ctx: Record<string, unknown>) => Promise<unknown>;
const authedServer = (authed as unknown as { options: { server: ServerFn } }).options.server;
const accessServer = (accessMiddleware as unknown as { options: { server: ServerFn } }).options
  .server;
const gateServer = (publicServerFnGate as unknown as { options: { server: ServerFn } }).options
  .server;
const publicFnServer = (publicFn as unknown as { options: { server: ServerFn } }).options.server;

/** The page request that is being server-rendered when a loader calls the server function. */
function ssrPage(href: string, cookie?: string) {
  state.request = new Request(href, { headers: cookie ? { cookie } : {} });
}

/**
 * Runs `authed` the way Start's `executeMiddleware` does during SSR and returns what Start keeps:
 * `{ result }` or `{ error }`. That value ends up in the router or query state that is dehydrated
 * with seroval, so it must be serializable.
 */
async function runAuthedDuringSsr(): Promise<{ outcome: unknown; next: ReturnType<typeof vi.fn> }> {
  const next = vi.fn(async (ctx: { context: { actor: Actor } }) => ({
    context: ctx.context,
    result: { email: ctx.context.actor.kind === "user" ? ctx.context.actor.email : null },
  }));
  // On a page request the global access middleware skips, so `actor` is undefined here.
  try {
    const out = (await authedServer({ next, context: { actor: undefined } })) as {
      result: unknown;
    };
    return { outcome: { result: out.result }, next };
  } catch (error) {
    return { outcome: { error }, next };
  }
}

describe("authed during SSR (in-process server function call from a loader)", () => {
  beforeEach(() => {
    state.request = new Request("http://app.test/");
  });

  it("resolves the session itself and yields a seroval-serializable outcome", async () => {
    ssrPage("http://app.test/settings", VALID_COOKIE);
    const { outcome, next } = await runAuthedDuringSsr();
    // Before the fix this rejected with SerovalUnsupportedTypeError: a 401 Response was nested.
    await expect(toJSONAsync(outcome)).resolves.toBeDefined();
    expect(outcome).toEqual({ result: { email: USER.kind === "user" ? USER.email : null } });
    expect(next).toHaveBeenCalledWith({ context: { actor: USER } });
  });

  it("without a session throws the router redirect to /login with the page as `redirect`", async () => {
    ssrPage("http://app.test/settings?tab=github");
    const { outcome, next } = await runAuthedDuringSsr();
    const error = (outcome as { error: unknown }).error;
    expect(isRedirect(error)).toBe(true);
    const options = (error as unknown as { options: { href: string } }).options;
    expect(options.href).toBe(`/login?redirect=${encodeURIComponent("/settings?tab=github")}`);
    // The redirect's options are what Start serializes for the client; they must be plain data.
    await expect(toJSONAsync({ ...options })).resolves.toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it("passes an actor set by the global middleware straight through", async () => {
    const next = vi.fn(async () => ({ result: 1 }));
    await authedServer({ next, context: { actor: USER } });
    expect(next).toHaveBeenCalledWith({ context: { actor: USER } });
  });
});

/** Start's `next()` rethrows what the handler threw (`if ("error" in result) throw ...`). */
const throwingNext = (error: unknown) => vi.fn(async () => Promise.reject(error));

describe("authed when the server function's logic throws", () => {
  it("rejects instead of resolving, with a ServerFnError carrying a requestId", async () => {
    const outcome = authedServer({
      next: throwingNext(new Error(INTERNAL_DETAIL)),
      context: { actor: USER },
    });
    await expect(outcome).rejects.toBeInstanceOf(ServerFnError);
    const error = (await outcome.catch((e: unknown) => e)) as InstanceType<typeof ServerFnError>;
    expect(error.kind).toBe("internal");
    expect(error.status).toBe(500);
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(error.message).not.toContain("hunter2");
  });

  it("is seroval-serializable; the browser gets the code and requestId, never the internal message", async () => {
    const error = await authedServer({
      next: throwingNext(new Error(INTERNAL_DETAIL)),
      context: { actor: USER },
    }).catch((e: unknown) => e);
    const wire = await overTheWire(error);
    expect(wire.json).not.toContain("hunter2");
    expect(wire.json).not.toContain("auth-middleware");
    const info = parseServerFnError(wire.error);
    expect(info).toEqual({
      kind: "internal",
      message: "Internal server error.",
      requestId: (error as InstanceType<typeof ServerFnError>).requestId,
    });
  });

  it("lets a router redirect through unchanged", async () => {
    const redirect = toRedirect({ href: "/login" });
    const error = await authedServer({
      next: throwingNext(redirect),
      context: { actor: USER },
    }).catch((e: unknown) => e);
    expect(error).toBe(redirect);
  });

  it("lets a deliberate ServerFnError through unchanged", async () => {
    const thrown = new ServerFnError({
      kind: "forbidden",
      message: "You are not allowed to perform this action.",
      requestId: "r-1",
      status: 403,
    });
    const error = await authedServer({
      next: throwingNext(thrown),
      context: { actor: USER },
    }).catch((e: unknown) => e);
    expect(error).toBe(thrown);
  });
});

describe("authed when the server function's input validator rejects", () => {
  const SECRET = "xoxb-secret-token-value";
  type Failure = InstanceType<typeof ServerFnError>;
  const fail = (error: unknown) =>
    authedServer({ next: throwingNext(error), context: { actor: USER } }).catch(
      (e: unknown) => e,
    ) as Promise<Failure>;

  it("a validator's plain `Invalid ...` error reaches the client as code `validation`, status 400", async () => {
    const error = await fail(new Error("Invalid Slack secret input."));
    expect(error).toBeInstanceOf(ServerFnError);
    expect(error.status).toBe(400);
    expect(error.kind).toBe("validation");
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const wire = await overTheWire(error);
    expect(parseServerFnError(wire.error)).toEqual({
      kind: "validation",
      message: "The request is invalid.",
      requestId: error.requestId,
    });
  });

  it("a ZodError becomes `validation` / 400 without echoing the issues (they can carry input)", async () => {
    const { z } = await import("zod");
    const parsed = z.strictObject({ token: z.string().max(4) }).safeParse({ token: SECRET });
    expect(parsed.success).toBe(false);
    const error = await fail(parsed.error);
    expect(error.status).toBe(400);
    expect(error.kind).toBe("validation");
    const wire = await overTheWire(error);
    expect(wire.json).not.toContain(SECRET);
    expect(wire.json).not.toContain("too_big");
  });

  it("Start's standard-schema failure (issues as a JSON message) becomes `validation` / 400", async () => {
    const issues = [{ message: `bad value ${SECRET}`, path: ["token"] }];
    const error = await fail(new Error(JSON.stringify(issues, undefined, 2)));
    expect(error.status).toBe(400);
    expect(error.kind).toBe("validation");
    expect((await overTheWire(error)).json).not.toContain(SECRET);
  });

  it("other errors stay `internal` / 500", async () => {
    for (const thrown of [new TypeError("Invalid URL"), new Error("boom"), new Error("[1, 2]")]) {
      const error = await fail(thrown);
      expect(error.kind).toBe("internal");
      expect(error.status).toBe(500);
    }
  });
});

async function run(request: Request, handlerType: "serverFn" | "router") {
  const next = vi.fn(async () => new Response("ok"));
  const res = await accessServer({
    next,
    request,
    pathname: new URL(request.url).pathname,
    handlerType,
  });
  return { res: res as Response, next };
}

describe("accessMiddleware", () => {
  it("an anonymous browser server-function call gets a 401 the Start client turns into a redirect to /login", async () => {
    const { res, next } = await run(
      new Request("http://app.test/_serverFn/abc", {
        headers: { "x-tsr-serverfn": "true", referer: "http://app.test/merge?pr=7" },
      }),
      "serverFn",
    );
    // The call runs through the function middleware, where only a public function is admitted.
    expect(next).toHaveBeenCalledWith({
      context: { actor: undefined, anonymousCall: expect.any(AnonymousCall) },
    });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    // What `serverFnFetcher` does with a JSON body that is not seroval-framed (`parseRedirect`).
    expect(body.isSerializedRedirect).toBe(true);
    expect(isRedirect(toRedirect(body))).toBe(true);
    expect(body.href).toBe(`/login?redirect=${encodeURIComponent("/merge?pr=7")}`);
  });

  it("ignores a cross-origin Referer for the post-login target", async () => {
    const { res } = await run(
      new Request("http://app.test/_serverFn/abc", {
        headers: { "x-tsr-serverfn": "true", referer: "https://evil.example/x" },
      }),
      "serverFn",
    );
    expect((await res.json()).href).toBe("/login");
  });

  it("API routes keep the plain 401 toHttp contract", async () => {
    const { res, next } = await run(new Request("http://app.test/api/me"), "router");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ kind: "unauthenticated", message: "Authentication is required." });
    expect(body.isSerializedRedirect).toBeUndefined();
  });

  it("a server-function call whose actor resolution fails throws a ServerFnError, not a JSON body", async () => {
    const outcome = run(
      new Request("http://app.test/_serverFn/abc", {
        headers: { "x-tsr-serverfn": "true", cookie: "session=boom" },
      }),
      "serverFn",
    );
    // Start serializes a thrown error as `{ error }`, so the client call rejects; a returned
    // non-seroval JSON body would be handed to the caller as data.
    const error = await outcome.then(
      ({ res }) => res,
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(Response);
    expect(error).toBeInstanceOf(ServerFnError);
    const wire = await overTheWire(error);
    expect(wire.json).not.toContain("hunter2");
    expect(parseServerFnError(wire.error)).toMatchObject({ kind: "internal" });
    expect((error as InstanceType<typeof ServerFnError>).status).toBe(500);
  });

  it("API routes keep the JSON 500 contract when actor resolution fails", async () => {
    const { res } = await run(
      new Request("http://app.test/api/me", { headers: { cookie: "session=boom" } }),
      "router",
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "internal", message: "Internal server error." });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it.each([
    ["the former machine token", `Bearer ${"m".repeat(40)}`],
    ["any bearer", "Bearer anything"],
    ["a non-bearer scheme", "Basic dXNlcjpwYXNz"],
  ])("an API request with %s is 401, with or without a valid cookie", async (_name, header) => {
    for (const cookie of [undefined, VALID_COOKIE]) {
      const headers: Record<string, string> = { authorization: header };
      if (cookie) headers.cookie = cookie;
      const { res, next } = await run(new Request("http://app.test/api/me", { headers }), "router");
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ kind: "unauthenticated" });
    }
  });

  it("a server-function call with any Authorization header is rejected even with a valid cookie", async () => {
    const { res, next } = await run(
      new Request("http://app.test/_serverFn/abc", {
        headers: {
          "x-tsr-serverfn": "true",
          authorization: `Bearer ${"m".repeat(40)}`,
          cookie: VALID_COOKIE,
        },
      }),
      "serverFn",
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("pages pass through without an actor", async () => {
    const { next } = await run(new Request("http://app.test/settings"), "router");
    expect(next).toHaveBeenCalledWith({ context: { actor: undefined, anonymousCall: undefined } });
  });

  it("a valid session reaches the server function with its actor", async () => {
    const { next } = await run(
      new Request("http://app.test/_serverFn/abc", { headers: { cookie: VALID_COOKIE } }),
      "serverFn",
    );
    expect(next).toHaveBeenCalledWith({ context: { actor: USER, anonymousCall: undefined } });
  });

  it("an anonymous call the gate admitted gets the server function's response", async () => {
    const next = vi.fn(async (opts: { context: { anonymousCall: { admit(): void } } }) => {
      opts.context.anonymousCall.admit();
      return new Response("public result");
    });
    const res = (await accessServer({
      next,
      request: new Request("http://app.test/_serverFn/abc", {
        headers: { "x-tsr-serverfn": "true" },
      }),
      pathname: "/_serverFn/abc",
      handlerType: "serverFn",
    })) as Response;
    expect(await res.text()).toBe("public result");
  });

  it("an anonymous call that the function middleware threw on is still the 401 redirect", async () => {
    const next = vi.fn(async () => {
      throw new Error("refused");
    });
    const res = (await accessServer({
      next,
      request: new Request("http://app.test/_serverFn/abc", {
        headers: { "x-tsr-serverfn": "true" },
      }),
      pathname: "/_serverFn/abc",
      handlerType: "serverFn",
    })) as Response;
    expect(res.status).toBe(401);
    expect((await res.json()).isSerializedRedirect).toBe(true);
  });
});

describe("publicServerFnGate (global function middleware)", () => {
  const PUBLIC = { id: "x", filename: "src/functions/login-token.ts", name: "loginWithToken" };

  it("admits an anonymous call to a public server function", async () => {
    const call = new AnonymousCall();
    const next = vi.fn(async () => ({ result: "ok" }));
    await gateServer({ next, context: { anonymousCall: call }, serverFnMeta: PUBLIC });
    expect(next).toHaveBeenCalled();
    expect(call.admitted).toBe(true);
  });

  it.each([
    ["another function in the same file", { ...PUBLIC, name: "rotateLoginToken" }],
    ["the same name in another file", { ...PUBLIC, filename: "src/functions/viewer.ts" }],
    ["a lookalike path", { ...PUBLIC, filename: "src/functions/login-token.ts/../viewer.ts" }],
    ["no metadata", undefined],
  ])("refuses an anonymous call to %s without running it", async (_name, serverFnMeta) => {
    const call = new AnonymousCall();
    const next = vi.fn(async () => ({ result: "ok" }));
    await expect(
      gateServer({ next, context: { anonymousCall: call }, serverFnMeta }),
    ).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(call.admitted).toBe(false);
  });

  it("leaves calls with a session or in-process (SSR) calls alone", async () => {
    for (const context of [{ actor: USER, anonymousCall: undefined }, { actor: undefined }]) {
      const next = vi.fn(async () => ({ result: "ok" }));
      await gateServer({ next, context, serverFnMeta: { ...PUBLIC, name: "rotateLoginToken" } });
      expect(next).toHaveBeenCalled();
    }
  });

  it("does not trust a look-alike marker object (client-sent context)", async () => {
    const fake = {
      admitted: false,
      admit() {
        fake.admitted = true;
      },
    };
    const next = vi.fn(async () => ({ result: "ok" }));
    await gateServer({ next, context: { anonymousCall: fake }, serverFnMeta: PUBLIC });
    // Not an AnonymousCall: nothing is admitted; the request middleware answers 401 regardless.
    expect(fake.admitted).toBe(false);
  });
});

describe("publicFn", () => {
  it("maps a validator failure to validation / 400", async () => {
    const next = vi.fn(async () => {
      throw new Error("Invalid token.");
    });
    const error = await publicFnServer({ next, context: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerFnError);
    expect(error).toMatchObject({ kind: "validation", status: 400 });
  });

  it("hides an unexpected error behind internal / 500", async () => {
    const next = vi.fn(async () => {
      throw new Error(INTERNAL_DETAIL);
    });
    const error = await publicFnServer({ next, context: {} }).catch((e: unknown) => e);
    const wire = await overTheWire(error);
    expect(wire.json).not.toContain("hunter2");
    expect(error).toMatchObject({ kind: "internal", status: 500 });
  });

  it("passes the result through", async () => {
    const next = vi.fn(async () => ({ result: 1 }));
    expect(await publicFnServer({ next, context: {} })).toEqual({ result: 1 });
  });
});
