import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createPgDb } from "../../src/adapters/db/client";
import {
  bootWithout,
  startAppServer,
  type AppServer,
  type StopResult,
} from "../../src/testing/integration/app-server";
import { testPgUrl } from "../../src/testing/integration/urls";

const TOKEN = "correct horse battery 1";
const NEW_TOKEN = "rotated token 2";
const EMAIL_CREDENTIALS = {
  email: "owner@example.test",
  password: "correct horse battery staple 1",
  name: "Owner",
};

/** The seroval build the Start client serializes server function payloads with. */
const routerCore = createRequire(
  createRequire(import.meta.url).resolve("@tanstack/react-router"),
).resolve("@tanstack/router-core");
const { toJSONAsync } = (await import(createRequire(routerCore).resolve("seroval"))) as {
  toJSONAsync: (value: unknown) => Promise<unknown>;
};

/** The wire form (seroval node tree) of a server function's response `value`. */
const wireBody = async (value: unknown) =>
  ((await toJSONAsync({ result: value })) as { t: unknown }).t;

let app: AppServer;
let stopResult: StopResult | undefined;
const jar = () => app.cookieJar();
let session: ReturnType<AppServer["cookieJar"]>;

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${app.baseUrl}${path}`, { redirect: "manual", headers });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: app.baseUrl, ...headers },
    body: JSON.stringify(body),
  });

const sessionCookies = (res: Response) =>
  res.headers.getSetCookie().filter((c) => /session/i.test(c));

let pg: ReturnType<typeof createPgDb>;

/** Number of session rows for a cookie's token, read through SQL in the per-run schema. */
async function sessionRows(cookieHeader: string): Promise<number> {
  const raw = cookieHeader.split("; ").find((c) => c.startsWith("better-auth.session_token="));
  if (!raw) throw new Error("no session cookie in jar");
  const token = decodeURIComponent(raw.slice(raw.indexOf("=") + 1)).split(".")[0] ?? "";
  const rows = await pg.db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(app.schema)}."session" WHERE token = ${token}`,
  );
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n);
}

/** The real id of a server function, read from the build output (`<chunk>-*.mjs`). */
function serverFnId(chunk: string, name: string): string {
  const dir = ".output/server/_ssr";
  for (const file of readdirSync(dir).filter(
    (f) => f.startsWith(`${chunk}-`) && f.endsWith(".mjs"),
  )) {
    const m = new RegExp(`id: "([0-9a-f]{64})",\\s*name: "${name}"`).exec(
      readFileSync(`${dir}/${file}`, "utf8"),
    );
    if (m?.[1]) return m[1];
  }
  throw new Error(`${name} id not found in build output`);
}

const getViewerId = () => serverFnId("viewer", "getViewer");

/** Calls a server function the way the Start client does: seroval-framed `{ data }`. */
async function callFn(
  name: "getSetupStatus" | "initializeLoginToken" | "loginWithToken" | "rotateLoginToken",
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = `${app.baseUrl}/_serverFn/${serverFnId("login-token", name)}`;
  const base = { origin: app.baseUrl, "x-tsr-serverfn": "true", ...headers };
  if (name === "getSetupStatus") return fetch(url, { redirect: "manual", headers: base });
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...base },
    body: JSON.stringify(await toJSONAsync({ data })),
  });
}

beforeAll(async () => {
  app = await startAppServer();
  session = jar();
  pg = createPgDb({ url: testPgUrl(), searchPath: app.schema, max: 1, connectTimeout: 20 });
  await pg.db.execute(sql`SELECT 1`); // connect eagerly so a slow handshake fails here, not mid-test
}, 600_000);

afterAll(async () => {
  await pg?.close().catch(() => {});
  await app?.dispose();
}, 60_000);

describe("before setup", () => {
  it("the removed auth-status endpoint is not public (401)", async () => {
    const res = await get("/api/public/auth-status");
    expect(res.status).toBe(401);
  });

  it("GET /login redirects to /setup", async () => {
    const res = await get("/login");
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("/setup");
  });

  it("getSetupStatus is public and reports not initialized", async () => {
    const res = await callFn("getSetupStatus");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await wireBody({ initialized: false }));
  });

  it("loginWithToken is 404 not_found and sets no cookie", async () => {
    const res = await callFn("loginWithToken", { token: TOKEN });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not_found");
    expect(sessionCookies(res)).toEqual([]);
  });
});

describe("unauthenticated access", () => {
  it("GET / redirects to /login?redirect=%2F", async () => {
    const res = await get("/");
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("/login?redirect=%2F");
  });

  it("deep path keeps its query in the encoded redirect", async () => {
    const res = await get("/some/deep?x=1");
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe(
      `/login?redirect=${encodeURIComponent("/some/deep?x=1")}`,
    );
  });

  it("GET /api/me is 401 with the toHttp body and no internals", async () => {
    const res = await get("/api/me");
    expect(res.status).toBe(401);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ kind: "unauthenticated", message: "Authentication is required." });
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/stack/i);
    expect(text).not.toMatch(/Error:/);
    expect(text).not.toMatch(/\n\s+at /);
  });

  it("unknown /api path without an actor is 401", async () => {
    const res = await get("/api/nonexistent");
    expect(res.status).toBe(401);
  });
});

describe("Authorization header", () => {
  it.each(["Bearer anything", `Bearer ${"m".repeat(40)}`, "bearer x", "Basic dXNlcjpwYXNz"])(
    "%s is 401: there is no bearer credential",
    async (authorization) => {
      const res = await get("/api/me", { authorization });
      expect(res.status).toBe(401);
    },
  );
});

describe("path tricks never bypass auth", () => {
  it.each(["/api/auth/../me", "/api/auth/%2e%2e/me", "/API/me", "/api//me", "/api/me/"])(
    "%s is exactly 401 without auth",
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(401);
    },
  );
});

describe("email endpoints are gone", () => {
  it.each(["/api/auth/sign-up/email", "/api/auth/sign-in/email"])(
    "POST %s is 404 and creates nothing",
    async (path) => {
      const res = await post(path, EMAIL_CREDENTIALS);
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toEqual([]);
      const rows = await pg.db.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(app.schema)}."user"`,
      );
      expect(Number((rows as unknown as Array<{ n: number }>)[0]?.n)).toBe(0);
    },
  );
});

describe("setup, login, rotation, sign-out (ordered)", () => {
  it("initializeLoginToken from a foreign Origin is refused (CSRF)", async () => {
    const res = await callFn(
      "initializeLoginToken",
      { token: TOKEN, confirm: TOKEN },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("initializeLoginToken signs the owner in with a hardened session cookie", async () => {
    const res = await callFn("initializeLoginToken", { token: TOKEN, confirm: TOKEN });
    expect(res.status).toBe(200);
    const cookies = sessionCookies(res);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c).toMatch(/;\s*HttpOnly/i);
      expect(c).toMatch(/;\s*SameSite=Lax/i);
      expect(c).not.toMatch(/;\s*Secure/i);
    }
    session.store(res);
    const me = await get("/api/me", { cookie: session.header() });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ actor: { kind: "user" } });
  });

  it("stores only the hash", async () => {
    const rows = (await pg.db.execute(
      sql`SELECT token_hash FROM ${sql.identifier(app.schema)}."login_token"`,
    )) as unknown as Array<{ token_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toMatch(/^pbkdf2-sha256\$/);
    expect(rows[0]!.token_hash).not.toContain(TOKEN);
  });

  it("a second initializeLoginToken is 409 conflict", async () => {
    const res = await callFn("initializeLoginToken", { token: NEW_TOKEN, confirm: NEW_TOKEN });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("conflict");
    expect(sessionCookies(res)).toEqual([]);
  });

  it("getSetupStatus then reports initialized", async () => {
    expect(await (await callFn("getSetupStatus")).json()).toEqual(
      await wireBody({ initialized: true }),
    );
  });

  it("GET /login is 200 HTML once initialized", async () => {
    const res = await get("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("GET / with the cookie is 200 HTML", async () => {
    const res = await get("/", { cookie: session.header() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("server function getViewer works with the session and refuses without it", async () => {
    const res = await fetch(`${app.baseUrl}/_serverFn/${getViewerId()}`, {
      redirect: "manual",
      headers: { cookie: session.header(), origin: app.baseUrl, "x-tsr-serverfn": "true" },
    });
    expect(res.status).toBe(200);
    const anon = await fetch(`${app.baseUrl}/_serverFn/${getViewerId()}`, {
      redirect: "manual",
      headers: { origin: app.baseUrl, "x-tsr-serverfn": "true" },
    });
    expect(anon.status).toBe(401);
  });

  it("any bearer beats a valid session cookie (401)", async () => {
    const res = await get("/api/me", {
      cookie: session.header(),
      authorization: `Bearer ${"m".repeat(40)}`,
    });
    expect(res.status).toBe(401);
  });

  it("a wrong token is a generic 401 with no session cookie", async () => {
    const res = await callFn("loginWithToken", { token: `${TOKEN}-wrong` });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("unauthenticated");
    expect(sessionCookies(res)).toEqual([]);
  });

  it("the right token signs in", async () => {
    const res = await callFn("loginWithToken", { token: TOKEN });
    expect(res.status).toBe(200);
    expect(sessionCookies(res).length).toBeGreaterThan(0);
  });

  it("rotateLoginToken without a session is the 401 login redirect", async () => {
    const res = await callFn("rotateLoginToken", {
      current: TOKEN,
      token: NEW_TOKEN,
      confirm: NEW_TOKEN,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ isSerializedRedirect: true });
  });

  it("rotateLoginToken revokes every session and clears the cookie", async () => {
    const oldCookie = session.header();
    const res = await callFn(
      "rotateLoginToken",
      { current: TOKEN, token: NEW_TOKEN, confirm: NEW_TOKEN },
      { cookie: oldCookie },
    );
    expect(res.status).toBe(200);
    expect(sessionCookies(res).some((c) => /Max-Age=0/i.test(c))).toBe(true);
    expect(await sessionRows(oldCookie)).toBe(0);
    const rows = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(app.schema)}."session"`,
    );
    expect(Number((rows as unknown as Array<{ n: number }>)[0]?.n)).toBe(0);
    expect((await get("/api/me", { cookie: oldCookie })).status).toBe(401);
  });

  it("after rotation the old token is rejected and the new one signs in", async () => {
    expect((await callFn("loginWithToken", { token: TOKEN })).status).toBe(401);
    const res = await callFn("loginWithToken", { token: NEW_TOKEN });
    expect(res.status).toBe(200);
    session = jar();
    session.store(res);
    expect((await get("/api/me", { cookie: session.header() })).status).toBe(200);
  });

  it("sign-out invalidates the session", async () => {
    const oldCookie = session.header();
    expect(await sessionRows(oldCookie)).toBe(1);
    const out = await post("/api/auth/sign-out", {}, { cookie: oldCookie });
    expect(out.status).toBe(200);
    expect((await get("/api/me", { cookie: oldCookie })).status).toBe(401);
    expect(await sessionRows(oldCookie)).toBe(0);
  });

  it("5 wrong tokens lock the IP out with 429 and Retry-After, even for the right token", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await callFn("loginWithToken", { token: `wrong-${i}-token` })).status).toBe(401);
    }
    const res = await callFn("loginWithToken", { token: NEW_TOKEN });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.text()).toContain("rate_limited");
    expect(sessionCookies(res)).toEqual([]);
  });

  it("never logs a token", () => {
    const log = readFileSync(app.logFile, "utf8");
    for (const t of [TOKEN, NEW_TOKEN]) expect(log).not.toContain(t);
  });
});

describe("slack events route", () => {
  it("is public by policy: passes the auth layer to the signature check, 503 without a stored signing secret", async () => {
    const res = await post("/api/slack/events", {});
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ kind: "not_configured", feature: "slack_events" });
  });
});

describe("server functions", () => {
  it("an anonymous POST to a real server-function endpoint is 401 or 403, never 200", async () => {
    const res = await fetch(`${app.baseUrl}/_serverFn/${getViewerId()}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: app.baseUrl },
      body: "{}",
    });
    expect([401, 403]).toContain(res.status);
  });

  it("an anonymous cross-origin POST is refused by CSRF (403)", async () => {
    const res = await fetch(`${app.baseUrl}/_serverFn/${getViewerId()}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});

describe("fail fast at boot (architecture principle 5)", () => {
  it("exits non-zero within 10 s naming BETTER_AUTH_SECRET, without printing values", async () => {
    const r = await bootWithout(["BETTER_AUTH_SECRET"], 15_000);
    expect(r.signal).toBeNull();
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.ms).toBeLessThan(10_000);
    expect(r.output).toContain("BETTER_AUTH_SECRET");
    expect(r.leaked).toBe(false);
  }, 30_000);
});

describe("shutdown", () => {
  it("exits 0 within 5 s of SIGTERM", async () => {
    stopResult = await app.stop();
    expect(stopResult.code).toBe(0);
    expect(stopResult.ms).toBeLessThan(5_000);
  });
});
