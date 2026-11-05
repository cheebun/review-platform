import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { AuthPort } from "../../ports/auth";
import type { Db } from "../db/client";
import { PgLoginTokenStore } from "../db/pg-login-token-store";
import { account, session, user } from "../db/schema";
import { SystemClock } from "../system/system-clock";
import { createAuth, OWNER_USER_EMAIL, type Auth } from "./auth";
import { createBetterAuthPort } from "./better-auth-port";

const BASE_URL = "http://localhost:3000";
const SESSION_COOKIE = "better-auth.session_token";
const HASH_A = "pbkdf2-sha256$600000$c2FsdA$aGFzaC1h";
const HASH_B = "pbkdf2-sha256$600000$c2FsdA$aGFzaC1i";

/** The `name=value` pair of the session cookie in a Set-Cookie list. */
function sessionCookie(headers: Headers): string {
  const raw = headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) throw new Error("no session cookie in Set-Cookie");
  return raw;
}

/**
 * Passwordless sessions of the auth factory: owner sign-in after the login token was checked,
 * rotation, and the closed email endpoints. Runs on PGlite (db-fast) and on remote PostgreSQL
 * (integration). `getDb` is called lazily, after the fixture's beforeAll.
 */
export function authFlowSuite(getDb: () => Db, opts: { full: boolean }): void {
  let auth: Auth;
  let db: Db;
  let port: AuthPort;
  let loginTokens: PgLoginTokenStore;
  const clock = new SystemClock();

  beforeAll(() => {
    db = getDb();
    auth = createAuth({
      db,
      secret: randomBytes(32).toString("base64"),
      baseURL: BASE_URL,
      trustedOrigins: [BASE_URL],
    });
    port = createBetterAuthPort(auth, { db, clock });
    loginTokens = new PgLoginTokenStore(db, clock);
  });

  /** Signs the owner in and returns the browser's cookie header. */
  async function signIn(): Promise<{ setCookie: string; headers: Headers }> {
    const { headers } = await auth.api.issueOwnerSession({
      headers: new Headers(),
      returnHeaders: true,
    });
    const setCookie = sessionCookie(headers);
    return { setCookie, headers: new Headers({ cookie: setCookie.split(";")[0]! }) };
  }

  async function insertUser(id: string, email: string, createdAt: Date) {
    await db.insert(user).values({ id, name: id, email, createdAt, updatedAt: createdAt });
  }

  describe("owner sessions", () => {
    it("creates the single internal owner user on first sign-in, without an account", async () => {
      const { headers } = await signIn();
      const users = await db.select().from(user);
      expect(users).toEqual([expect.objectContaining({ email: OWNER_USER_EMAIL })]);
      expect(await db.select().from(account)).toEqual([]);
      expect(await port.getSessionActor(headers)).toEqual({
        kind: "user",
        userId: users[0]!.id,
        email: OWNER_USER_EMAIL,
      });
    });

    it("reuses the existing user (the oldest) instead of creating one", async () => {
      await insertUser("newer", "b@example.com", new Date("2025-02-01T00:00:00Z"));
      await insertUser("older", "a@example.com", new Date("2025-01-01T00:00:00Z"));
      const { headers } = await signIn();
      expect(await db.select().from(user)).toHaveLength(2);
      expect(await port.getSessionActor(headers)).toMatchObject({ userId: "older" });
    });

    it("keeps one user across repeated and concurrent sign-ins", async () => {
      await Promise.all([signIn(), signIn(), signIn()]);
      await signIn();
      expect(await db.select().from(user)).toHaveLength(1);
      expect(await db.select().from(session)).toHaveLength(4);
    });

    it("issues an HttpOnly, SameSite=Lax cookie (not Secure over http)", async () => {
      const { setCookie } = await signIn();
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).not.toMatch(/;\s*Secure/i);
    });

    it("returns null for a tampered cookie", async () => {
      const { headers } = await signIn();
      const cookie = headers.get("cookie")!;
      const value = cookie.slice(SESSION_COOKIE.length + 1);
      const flipped = (value[0] === "a" ? "b" : "a") + value.slice(1);
      const tampered = new Headers({ cookie: `${SESSION_COOKIE}=${flipped}` });
      expect(await port.getSessionActor(tampered)).toBeNull();
    });

    it("returns null once the session has expired", async () => {
      const { headers } = await signIn();
      expect(await port.getSessionActor(headers)).not.toBeNull();
      await db.execute(sql`UPDATE ${session} SET expires_at = now() - interval '1 hour'`);
      expect(await port.getSessionActor(headers)).toBeNull();
    });

    it("expires the session cookie on request", async () => {
      const { headers } = await auth.api.expireSessionCookie({
        headers: new Headers(),
        returnHeaders: true,
      });
      expect(sessionCookie(headers)).toMatch(/Max-Age=0/i);
    });
  });

  describe("rotateLoginToken", () => {
    it("replaces the hash and deletes every session in one go", async () => {
      await loginTokens.initialize(HASH_A);
      const a = await signIn();
      await signIn();
      expect(await port.rotateLoginToken(HASH_B)).toEqual({ ok: true, value: undefined });
      expect(await loginTokens.getHash()).toBe(HASH_B);
      expect(await db.select().from(session)).toEqual([]);
      expect(await port.getSessionActor(a.headers)).toBeNull();
    });

    it("is not_found before initialization and keeps the sessions", async () => {
      await signIn();
      expect(await port.rotateLoginToken(HASH_B)).toEqual({
        ok: false,
        error: { kind: "not_found", entity: "login_token" },
      });
      expect(await db.select().from(session)).toHaveLength(1);
    });

    it("rejects a value that is not an encoded hash, changing nothing", async () => {
      await loginTokens.initialize(HASH_A);
      await signIn();
      await expect(port.rotateLoginToken("plaintext")).rejects.toThrow();
      expect(await loginTokens.getHash()).toBe(HASH_A);
      expect(await db.select().from(session)).toHaveLength(1);
    });
  });

  describe("closed email endpoints", () => {
    const post = (path: string, body: unknown) =>
      port.handler(
        new Request(`${BASE_URL}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify(body),
        }),
      );
    const credentials = {
      email: "mallory@example.com",
      password: "correct horse battery staple",
      name: "M",
    };

    it.each(["/sign-up/email", "/sign-in/email"])(
      "POST %s fails and creates no user or session",
      async (path) => {
        const res = await post(path, credentials);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.headers.getSetCookie()).toEqual([]);
        // better-auth itself refuses too, should the port's route allowlist ever change.
        const direct = await auth.handler(
          new Request(`${BASE_URL}/api/auth${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE_URL },
            body: JSON.stringify(credentials),
          }),
        );
        expect(direct.status).toBeGreaterThanOrEqual(400);
        expect(direct.headers.getSetCookie()).toEqual([]);
        expect(await db.select().from(user)).toEqual([]);
        expect(await db.select().from(session)).toEqual([]);
      },
    );

    it("fails a sign-in with the owner user's email too", async () => {
      await signIn();
      const res = await post("/sign-in/email", { ...credentials, email: OWNER_USER_EMAIL });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await db.select().from(session)).toHaveLength(1);
    });

    it("rejects the server-side email APIs too", async () => {
      await expect(auth.api.signUpEmail({ body: credentials })).rejects.toThrow();
      await expect(
        auth.api.signInEmail({
          body: { email: credentials.email, password: credentials.password },
        }),
      ).rejects.toThrow();
      expect(await db.select().from(user)).toEqual([]);
    });

    it.each([
      ["POST", "/update-user"],
      ["POST", "/change-password"],
      ["POST", "/change-email"],
      ["POST", "/delete-user"],
      ["POST", "/sign-in/social"],
      ["POST", "/request-password-reset"],
      ["GET", "/list-sessions"],
      ["POST", "/revoke-sessions"],
    ])("%s %s is not served", async (method, path) => {
      const { headers } = await signIn();
      const init: RequestInit = { headers: { cookie: headers.get("cookie")!, origin: BASE_URL } };
      if (method === "POST") Object.assign(init, { method, body: "{}" });
      const res = await port.handler(new Request(`${BASE_URL}/api/auth${path}`, init));
      expect(res.status).toBe(404);
    });

    it("still serves get-session and sign-out", async () => {
      const { headers } = await signIn();
      const cookie = headers.get("cookie")!;
      const got = await port.handler(
        new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }),
      );
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({ user: { email: OWNER_USER_EMAIL } });
      const out = await port.handler(
        new Request(`${BASE_URL}/api/auth/sign-out`, {
          method: "POST",
          headers: { cookie, origin: BASE_URL, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(out.status).toBe(200);
      expect(await db.select().from(session)).toEqual([]);
    });
  });

  if (opts.full) {
    describe("session policy", () => {
      it("issues 7-day sessions", async () => {
        await signIn();
        const [row] = await db.select().from(session);
        const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(6.9);
        expect(days).toBeLessThanOrEqual(7);
      });

      it("marks the cookie Secure for an https baseURL", async () => {
        const secure = createAuth({
          db,
          secret: randomBytes(32).toString("base64"),
          baseURL: "https://app.example.com",
        });
        const { headers } = await secure.api.issueOwnerSession({
          headers: new Headers(),
          returnHeaders: true,
        });
        expect(headers.getSetCookie().join("\n")).toMatch(/;\s*Secure/i);
      });
    });
  }
}
