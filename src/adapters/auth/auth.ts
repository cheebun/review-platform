import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import type { Db } from "../db/client";
import { schema } from "../db/schema";

export type CreateAuthOptions = {
  db: Db;
  /** BETTER_AUTH_SECRET, at least 32 bytes of entropy. */
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
};

/**
 * Email of the internal owner user when none exists yet. Never shown and never used to sign in:
 * there is no email login. `.invalid` (RFC 2606) can never be a real address.
 */
export const OWNER_USER_EMAIL = "owner@agent-ops.invalid";

const DAY_SECONDS = 60 * 60 * 24;

type InternalAdapter = Awaited<ReturnType<typeof betterAuth>["$context"]>["internalAdapter"];

const oldestUser = async (adapter: InternalAdapter) =>
  (await adapter.listUsers(1, 0, { field: "createdAt", direction: "asc" }))[0] ?? null;

/**
 * The single owner user: the oldest existing user (an instance upgraded from email login keeps
 * its user and data), else a new internal one. Concurrent first sign-ins race on the unique
 * email; the loser finds the winner's row.
 */
async function ensureOwnerUser(adapter: InternalAdapter) {
  const existing = await oldestUser(adapter);
  if (existing) return existing;
  try {
    return await adapter.createUser(
      { email: OWNER_USER_EMAIL, name: "Owner", emailVerified: false },
      { method: "login-token" },
    );
  } catch (error) {
    const winner = await oldestUser(adapter);
    if (winner) return winner;
    throw error;
  }
}

/**
 * Passwordless sessions. Server-only endpoints: callable through `auth.api.*` after the login
 * token was checked, never routed over HTTP. Going through better-auth keeps its cookie name,
 * attributes, signing and expiry.
 */
const ownerSession = () =>
  ({
    id: "owner-session",
    endpoints: {
      issueOwnerSession: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        const adapter = ctx.context.internalAdapter;
        const owner = await ensureOwnerUser(adapter);
        const session = await adapter.createSession(owner.id);
        await setSessionCookie(ctx, { session, user: owner });
        return ctx.json({ ok: true });
      }),
      expireSessionCookie: createAuthEndpoint.serverOnly({ method: "POST" }, async (ctx) => {
        deleteSessionCookie(ctx);
        return ctx.json({ ok: true });
      }),
    },
  }) satisfies BetterAuthPlugin;

/**
 * Builds the better-auth instance. Pure: nothing is read from the environment, so tests and the
 * composition root control every input.
 *
 * No email/password: `emailAndPassword` stays disabled, so the sign-up/sign-in email endpoints
 * refuse, and `disabledPaths` keeps them off the router as well. Sign-in is `issueOwnerSession`,
 * reached only from the login token use cases.
 */
export function createAuth(opts: CreateAuthOptions) {
  const secure = new URL(opts.baseURL).protocol === "https:";
  return betterAuth({
    database: drizzleAdapter(opts.db, { provider: "pg", schema }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins ?? [],
    emailAndPassword: { enabled: false },
    disabledPaths: ["/sign-up/email", "/sign-in/email"],
    session: { expiresIn: 7 * DAY_SECONDS, updateAge: DAY_SECONDS },
    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, secure, sameSite: "lax" },
    },
    // Must stay last: it forwards Set-Cookie to the TanStack Start response.
    plugins: [ownerSession(), tanstackStartCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
