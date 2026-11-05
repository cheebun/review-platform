import type { Actor } from "../../domain/shared/actor";
import { ok, type Result } from "../../domain/shared/result";
import type { AuthPort } from "../../ports/auth";
import type { Clock } from "../../ports/system";
import type { Db } from "../db/client";
import { rotateLoginTokenHash } from "../db/pg-login-token-store";
import { session } from "../db/schema";
import type { Auth } from "./auth";

const BASE_PATH = "/api/auth";

/**
 * The only better-auth routes served over HTTP; everything else is 404 (default deny). Sign-in
 * is a server function, so no account, user, email or password endpoint is reachable.
 */
const SERVED_ROUTES = new Set(["GET /get-session", "POST /sign-out", "GET /ok"]);

function isServed(request: Request): boolean {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${BASE_PATH}/`)) return false;
  return SERVED_ROUTES.has(`${request.method} ${pathname.slice(BASE_PATH.length)}`);
}

/** Adapts a better-auth instance to `AuthPort`. `db` must be the one `auth` was built with. */
export function createBetterAuthPort(auth: Auth, deps: { db: Db; clock: Clock }): AuthPort {
  return {
    async getSessionActor(headers: Headers): Promise<Actor | null> {
      const found = await auth.api.getSession({ headers });
      if (!found) return null;
      return { kind: "user", userId: found.user.id, email: found.user.email };
    },
    handler: async (request) =>
      isServed(request) ? auth.handler(request) : new Response(null, { status: 404 }),
    async signInOwner(headers) {
      await auth.api.issueOwnerSession({ headers });
    },
    async clearSessionCookie(headers) {
      await auth.api.expireSessionCookie({ headers });
    },
    rotateLoginToken: (hash) =>
      deps.db.transaction(async (tx): Promise<Result<void>> => {
        const rotated = await rotateLoginTokenHash(tx, hash, deps.clock.now());
        if (!rotated.ok) return rotated;
        // Every session, not only the caller's: a leaked token must not outlive its rotation.
        await tx.delete(session);
        return ok(undefined);
      }),
  };
}
