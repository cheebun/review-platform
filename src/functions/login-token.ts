import { createServerFn } from "@tanstack/react-start";
import {
  getRequest,
  getRequestIP,
  setResponseHeader,
  setResponseStatus,
} from "@tanstack/react-start/server";
import { authed, publicFn } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import {
  loadSetupStatus,
  parseLoginBody,
  parseRotateBody,
  runLoginWithToken,
  runRotateLoginToken,
  type LoginTokenFnPorts,
  type LoginTokenFnResult,
  type LoginTokenReply,
} from "./login-token.logic";

/*
 * Login token server functions. `getSetupStatus` and `loginWithToken` are callable without a session: they are on `isPublicServerFn`'s list (access-policy.ts), keyed
 * by this file's path and these names. Renaming or moving them closes them, never opens others.
 */

const tokenPorts = async (): Promise<LoginTokenFnPorts> => (await getContainer()).ports;

/**
 * The client IP for the attempt limit. X-Forwarded-For is not trusted: a client could set it
 * and pick its own bucket.
 */
const clientIp = () => getRequestIP();

/** Applies the reply's status and headers to the response and returns the result as data. */
function send(reply: LoginTokenReply): LoginTokenFnResult {
  if (reply.status !== 200) setResponseStatus(reply.status);
  for (const [name, value] of Object.entries(reply.headers ?? {})) setResponseHeader(name, value);
  return reply.result;
}

/** Whether the login token exists. Before setup every page goes to /setup (FR-AUTH-01). */
export const getSetupStatus = createServerFn({ method: "GET" })
  .middleware([publicFn])
  .handler(async () => loadSetupStatus(await tokenPorts()));

/**
 * Signs the owner in with the token. `not_found` before setup (go to /setup), `unauthenticated`
 * for a wrong token, `rate_limited` after 5 failures per IP in 15 minutes.
 */
export const loginWithToken = createServerFn({ method: "POST" })
  .middleware([publicFn])
  .validator(parseLoginBody)
  .handler(async ({ data }) =>
    send(await runLoginWithToken(await tokenPorts(), data, clientIp(), getRequest().headers)),
  );

/**
 * Replaces the token and signs every session out, this one included: on success the cookie is
 * cleared and the client goes to /login.
 */
export const rotateLoginToken = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseRotateBody)
  .handler(async ({ data, context }) =>
    send(
      await runRotateLoginToken(
        await tokenPorts(),
        context.actor,
        data,
        clientIp(),
        getRequest().headers,
      ),
    ),
  );
