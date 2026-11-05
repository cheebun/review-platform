/**
 * The error a server function call rejects with, shared by the server (which throws it) and the
 * browser (which recognises it). Client-safe: no server-only imports.
 *
 * Why the code and requestId live in the message: Start serializes every thrown `Error` with the
 * router's `ShallowErrorPlugin`, which keeps only `message`. The browser therefore receives
 * `new Error(message)`; `parseServerFnError` recovers the code and requestId from it. On the
 * server (an in-process call during SSR) the instance keeps its typed fields as well.
 *
 * The message is always one of the fixed public messages from `errors.ts`, never the message of
 * the error that caused it (S4).
 */
import type { HttpError, HttpErrorBody } from "../errors";

export type ServerFnErrorKind = HttpErrorBody["kind"];

export interface ServerFnErrorInfo {
  kind: ServerFnErrorKind;
  /** The fixed public message, without the code and requestId suffix. */
  message: string;
  requestId: string;
}

const ENCODED = /^(.*) \(([a-z_]{2,40}); requestId ([A-Za-z0-9-]{1,64})\)$/s;

function encode(info: ServerFnErrorInfo): string {
  return `${info.message} (${info.kind}; requestId ${info.requestId})`;
}

export class ServerFnError extends Error {
  readonly kind: ServerFnErrorKind;
  readonly requestId: string;
  readonly publicMessage: string;
  /** Read by Start for the HTTP status of the serialized error response. */
  readonly status: number;

  constructor(info: ServerFnErrorInfo & { status: number }) {
    super(encode(info));
    this.name = "ServerFnError";
    this.kind = info.kind;
    this.requestId = info.requestId;
    this.publicMessage = info.message;
    this.status = info.status;
    // No frames: they name server files and would be serialized by a plain seroval instance.
    this.stack = `${this.name}: ${this.message}`;
  }

  static fromHttp(http: HttpError): ServerFnError {
    return new ServerFnError({
      kind: http.body.kind,
      message: http.body.message,
      requestId: http.body.requestId,
      status: http.status,
    });
  }
}

function readString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/**
 * The code, public message and requestId of a server function error, whether it is the original
 * `ServerFnError` (server, in-process) or the `Error(message)` the browser deserialized. Null for
 * anything else.
 */
export function parseServerFnError(error: unknown): ServerFnErrorInfo | null {
  if (error instanceof ServerFnError) {
    return { kind: error.kind, message: error.publicMessage, requestId: error.requestId };
  }
  if (!(error instanceof Error)) return null;
  const match = ENCODED.exec(error.message);
  if (!match) return null;
  return { message: match[1]!, kind: match[2] as ServerFnErrorKind, requestId: match[3]! };
}

/**
 * Whether `error` says the caller has no session: a `ServerFnError`, its deserialized form, or an
 * error-as-data failure (`FnRequestError`) carrying `kind: "unauthenticated"`.
 */
export function isUnauthenticatedError(error: unknown): boolean {
  if (readString(error, "kind") === "unauthenticated") return true;
  return parseServerFnError(error)?.kind === "unauthenticated";
}

export const LOGIN_PATH = "/login";

/** The login URL, carrying the post-login target as `redirect` when there is one. */
export function loginHref(target: string | null): string {
  return target ? `${LOGIN_PATH}?redirect=${encodeURIComponent(target)}` : LOGIN_PATH;
}
