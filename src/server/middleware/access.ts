/**
 * Pure access decision for the global request middleware. The framework glue
 * (`auth-middleware.ts`) only feeds it request facts and applies the result.
 */
import { normalizePath, requiresAuth } from "../../application/identity/access-policy";
import type { Actor } from "../../domain/shared/actor";
import type { DomainError, Result } from "../../domain/shared/result";
import type { Logger } from "../../ports/system";
import { errorLogFields, toHttp, unexpectedToHttp, type HttpError } from "../errors";
import { LOGIN_PATH } from "./server-fn-error";

export { loginHref } from "./server-fn-error";

export type HandlerType = "serverFn" | "router";

export interface AccessInput {
  pathname: string;
  method: string;
  handlerType: HandlerType;
  headers: Headers;
  resolve: (headers: Headers) => Promise<Result<Actor, DomainError>>;
  newRequestId: () => string;
  logger: Logger;
}

export type AccessDecision =
  | { kind: "skip" }
  | { kind: "actor"; actor: Actor }
  | { kind: "reject"; http: HttpError };

/**
 * Whether this request is an API or server-function request, as opposed to a page.
 *
 * Fails closed: the router matches paths case-insensitively and tolerates repeated slashes, so
 * the comparison is on the decoded, slash-collapsed, lower-cased path. A path that cannot be
 * normalised (bad encoding, dot segments, backslash) is guarded.
 */
export function isGuardedPath(pathname: string, handlerType: HandlerType): boolean {
  if (handlerType === "serverFn") return true;
  const normalized = normalizePath(pathname);
  if (normalized === null) return true;
  const lower = normalized.toLowerCase();
  return lower === "/api" || lower.startsWith("/api/") || lower.startsWith("/_serverfn");
}

export async function decideAccess(i: AccessInput): Promise<AccessDecision> {
  if (!isGuardedPath(i.pathname, i.handlerType)) return { kind: "skip" };
  if (i.handlerType === "router" && !requiresAuth(i.pathname, i.method)) return { kind: "skip" };
  try {
    const result = await i.resolve(i.headers);
    if (result.ok) return { kind: "actor", actor: result.value };
    return { kind: "reject", http: toHttp(result.error, i.newRequestId()) };
  } catch (error) {
    const requestId = i.newRequestId();
    i.logger.error("actor resolution failed", { requestId, ...errorLogFields(error) });
    return { kind: "reject", http: unexpectedToHttp(error, requestId) };
  }
}

/**
 * `candidate` as a same-origin `path + search`, or null. The login page itself and server-function
 * endpoints are never a post-login target. The login page sanitises `redirect` again.
 */
function sameOriginTarget(candidate: string | null, origin: string): string | null {
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const lower = url.pathname.toLowerCase();
  if (lower === LOGIN_PATH || lower.startsWith("/_serverfn")) return null;
  const target = url.pathname + url.search;
  return target.startsWith("/") && !target.startsWith("//") ? target : null;
}

/**
 * Where to send the user after signing in: the page being server-rendered, or, for a browser
 * server-function call, the same-origin page that made it (`Referer`).
 */
export function postLoginTarget(request: { url: string; headers: Headers }): string | null {
  let origin: string;
  try {
    origin = new URL(request.url).origin;
  } catch {
    return null;
  }
  return (
    sameOriginTarget(request.url, origin) ??
    sameOriginTarget(request.headers.get("referer"), origin)
  );
}
