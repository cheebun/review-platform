/**
 * Framework glue for access control. The decision lives in `access.ts` (pure, unit-tested).
 *
 * - `accessMiddleware`: global request middleware. API requests get an actor or a `toHttp`
 *   response. Server-function requests get an actor, or for a missing session a 401 whose body is
 *   a serialized router redirect to /login, which the Start client throws as `redirect`. Any other
 *   rejection of a server-function request is thrown as a `ServerFnError`: Start serializes it as
 *   `{ error }`, so the browser call rejects. (A returned JSON `Response` would reach the caller
 *   as data.) Pages pass through (the `_authed` layout guards them).
 * - Public server functions (setup and login): an anonymous server-function request carries an
 *   `AnonymousCall` into the function middleware. `publicServerFnGate`, registered globally in
 *   `start.ts`, admits it only for a function on the `isPublicServerFn` list; anything else, or a
 *   gate that never ran, still gets the 401 redirect. Default deny.
 * - `publicFn`: function middleware for those public functions, mapping failures like `authed`.
 * - `authed`: function middleware giving a server function a typed, non-optional `context.actor`.
 *   During SSR the global middleware ran for the page (and skipped), so `authed` resolves the
 *   session itself; without one it throws the router's `redirect`, never a `Response` that would
 *   end up in dehydrated router or query state (seroval cannot serialize it). An unexpected throw
 *   from the server function becomes a `ServerFnError` with a requestId and the generic message,
 *   so internals never reach the browser (S4). A rejected input (the function's validator threw)
 *   becomes a `validation` / 400 `ServerFnError` instead.
 */
import { isNotFound, isRedirect, redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ConsoleLogger } from "../../adapters/system/console-logger";
import { CryptoIdGenerator } from "../../adapters/system/crypto-id-generator";
import { isPublicServerFn } from "../../application/identity/access-policy";
import { resolveActor } from "../../application/identity/resolve-actor";
import type { Actor } from "../../domain/shared/actor";
import { errorLogFields, toHttp, unexpectedToHttp, type HttpError } from "../errors";
import { getContainer } from "../runtime";
import { decideAccess, loginHref, postLoginTarget } from "./access";
import { AnonymousCall } from "./anonymous-call";
import { ServerFnError } from "./server-fn-error";
import { isValidatorFailure } from "./validation-failure";

const ids = new CryptoIdGenerator();
const logger = new ConsoleLogger();

const JSON_NO_STORE = { "content-type": "application/json", "cache-control": "no-store" };

export function jsonResponse(http: HttpError): Response {
  return new Response(JSON.stringify(http.body), {
    status: http.status,
    headers: { ...JSON_NO_STORE, ...http.headers },
  });
}

/**
 * A server-function call without a session. Still a 401 (so non-browser callers and the HTTP
 * contract see "unauthenticated"), but the JSON body is a serialized router redirect: the Start
 * client's `serverFnFetcher` turns a non-seroval JSON body with `isSerializedRedirect` into a
 * thrown `redirect`, so the router navigates to the login page instead of treating the error
 * body as data.
 */
export function unauthenticatedServerFnResponse(request: Request): Response {
  const body = {
    isSerializedRedirect: true,
    href: loginHref(postLoginTarget(request)),
    statusCode: 307,
  };
  return new Response(JSON.stringify(body), { status: 401, headers: JSON_NO_STORE });
}

function resolveFromHeaders(headers: Headers) {
  return getContainer().then((container) => resolveActor({ headers, auth: container.ports.auth }));
}

export const accessMiddleware = createMiddleware().server(
  async ({ next, request, pathname, handlerType }) => {
    const decision = await decideAccess({
      pathname,
      method: request.method,
      handlerType,
      headers: request.headers,
      newRequestId: () => ids.uuid(),
      // The container is only touched when a request actually needs an actor.
      logger,
      resolve: resolveFromHeaders,
    });
    // `anonymousCall` is always set: server context keys override client-sent ones.
    const noCall = undefined as AnonymousCall | undefined;
    if (decision.kind === "reject") {
      if (handlerType === "serverFn" && decision.http.body.kind === "unauthenticated") {
        // A caller presenting credentials (any Authorization header) never gets a public call.
        if (request.headers.has("authorization")) return unauthenticatedServerFnResponse(request);
        // Lets the call reach the function middleware. Unless `publicServerFnGate` admitted it,
        // the outcome is discarded and the caller gets the 401 redirect, exactly as before; the
        // gate throws before a non-public function runs.
        const call = new AnonymousCall();
        try {
          const outcome = await next({
            context: {
              actor: undefined as Actor | undefined,
              anonymousCall: call as typeof noCall,
            },
          });
          if (call.admitted) return outcome;
        } catch (error) {
          if (call.admitted) throw error;
        }
        return unauthenticatedServerFnResponse(request);
      }
      if (handlerType === "serverFn") throw ServerFnError.fromHttp(decision.http);
      return jsonResponse(decision.http);
    }
    if (decision.kind === "actor") {
      return next({
        context: { actor: decision.actor as Actor | undefined, anonymousCall: noCall },
      });
    }
    return next({ context: { actor: undefined as Actor | undefined, anonymousCall: noCall } });
  },
);

/** Thrown by the gate; never reaches the caller (the request middleware answers 401). */
class AnonymousCallRefused extends Error {
  constructor() {
    super("anonymous call to a non-public server function");
    this.name = "AnonymousCallRefused";
  }
}

/**
 * Global function middleware (`start.ts`): admits an anonymous call only to a public server
 * function, and refuses every other one before it runs. Calls with a session and in-process SSR
 * calls carry no `AnonymousCall` and pass; `authed` guards those itself.
 */
export const publicServerFnGate = createMiddleware({ type: "function" }).server(
  async ({ next, context, serverFnMeta }) => {
    const call = (context as { anonymousCall?: unknown } | undefined)?.anonymousCall;
    if (call instanceof AnonymousCall) {
      if (!isPublicServerFn(serverFnMeta)) throw new AnonymousCallRefused();
      call.admit();
    }
    return next();
  },
);

/** For the public server functions: the same failure mapping as `authed`, without an actor. */
export const publicFn = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    throw toServerFnFailure(error);
  }
});

export const authed = createMiddleware({ type: "function" })
  .middleware([accessMiddleware])
  .server(async ({ next, context }) => {
    const actor = context.actor ?? (await resolveForInProcessCall());
    try {
      return await next({ context: { actor } });
    } catch (error) {
      throw toServerFnFailure(error);
    }
  });

/**
 * What a failed server function call rejects with. Router control flow (`redirect`, `notFound`),
 * a deliberately thrown `Response` and an existing `ServerFnError` pass through. A failed input
 * validator becomes a `validation` / 400 with the fixed public message (never the validator's
 * message or zod issues, which can echo the input). Anything else is logged (never its message)
 * and replaced by a generic `ServerFnError` carrying the requestId.
 *
 * Not exported on purpose: this module is in the browser graph (server functions import
 * `authed`). Start strips the `.server()` bodies there, and with them every binding only they
 * reference; an exported helper would keep `ids` (node:crypto) alive and break hydration.
 */
function toServerFnFailure(error: unknown): unknown {
  if (error instanceof ServerFnError || isRedirect(error) || isNotFound(error)) return error;
  if (error instanceof Response) return error;
  const requestId = ids.uuid();
  if (isValidatorFailure(error)) {
    logger.info("server function input rejected", { requestId, error: (error as Error).name });
    return ServerFnError.fromHttp(
      toHttp({ kind: "validation", message: "Invalid input." }, requestId),
    );
  }
  logger.error("server function failed", { requestId, ...errorLogFields(error) });
  return ServerFnError.fromHttp(unexpectedToHttp(error, requestId));
}

/**
 * `context.actor` is only missing when the server function runs in-process during SSR: the
 * global middleware ran for the page request and skipped it. (A browser RPC without a session
 * never gets here; the global middleware already answered it.) Every outcome is something the
 * router handles natively or seroval can serialize.
 */
async function resolveForInProcessCall(): Promise<Actor> {
  const request = getRequest();
  let result: Awaited<ReturnType<typeof resolveFromHeaders>>;
  try {
    result = await resolveFromHeaders(request.headers);
  } catch (error) {
    const requestId = ids.uuid();
    logger.error("actor resolution failed", { requestId, ...errorLogFields(error) });
    // No `cause` on purpose: this error is dehydrated to the browser, the cause may carry internals.
    // oxlint-disable-next-line preserve-caught-error
    throw ServerFnError.fromHttp(unexpectedToHttp(error, requestId));
  }
  if (result.ok) return result.value;
  throw redirect({ href: loginHref(postLoginTarget(request)) });
}
