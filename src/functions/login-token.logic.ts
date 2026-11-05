import { z } from "zod";
import {
  getSetupStatus,
  loginWithToken,
  rotateLoginToken,
  type LoginTokenDeps,
} from "../application/identity/login-token";
import type { Actor } from "../domain/shared/actor";
import type { DomainError, Result } from "../domain/shared/result";
import type { IdGenerator } from "../ports/system";
import { errorLogFields, toHttp, unexpectedToHttp, type HttpErrorBody } from "../server/errors";

/*
 * Server-only logic behind src/functions/login-token.ts: setup status, login and rotation
 * (FR-AUTH-01, -02, -07). First-run setup is src/functions/setup.logic.ts. The token is never
 * logged or echoed: validators throw fixed messages and errors carry only fixed public text.
 */

export type LoginTokenFnPorts = LoginTokenDeps & { ids: IdGenerator };

export type LoginTokenField = "token" | "confirm" | "current";

/** The fixed public body, plus the form field and its fixed domain message. */
export type LoginTokenErrorBody = HttpErrorBody & {
  field?: LoginTokenField;
  fieldMessage?: string;
  /** `rate_limited` only: whole seconds until the next attempt is allowed. */
  retryAfterSeconds?: number;
};

export type LoginTokenFnResult =
  | { ok: true; value: null }
  | { ok: false; error: LoginTokenErrorBody };

/**
 * What the server function returns (`result`, errors as data) and the HTTP status and headers it
 * sets on the response, so the wire status follows the contract (401, 409, 429 with Retry-After).
 */
export type LoginTokenReply = {
  result: LoginTokenFnResult;
  status: number;
  headers?: Record<string, string>;
};

// ---- Input validation (shape and size only; the domain applies the token rules) ----

/** Caps the payload only; the token itself has no maximum length (FR-AUTH-02). */
export const MAX_LOGIN_TOKEN_INPUT = 4096;

const tokenString = z.string().max(MAX_LOGIN_TOKEN_INPUT);
const loginSchema = z.strictObject({ token: tokenString });
const rotateSchema = z.strictObject({
  current: tokenString,
  token: tokenString,
  confirm: tokenString,
});

/** Validator for `loginWithToken`. The message is fixed: the input is a credential. */
export function parseLoginBody(input: unknown): { token: string } {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid login input.");
  return parsed.data;
}

/** Validator for `rotateLoginToken`. */
export function parseRotateBody(input: unknown): {
  current: string;
  token: string;
  confirm: string;
} {
  const parsed = rotateSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid login token input.");
  return parsed.data;
}

// ---- Running a use case ----

const FIELDS = new Set<string>(["token", "confirm", "current"]);
const isField = (field: string | undefined): field is LoginTokenField =>
  field !== undefined && FIELDS.has(field);

function failure(error: DomainError, requestId: string): LoginTokenReply {
  const http = toHttp(error, requestId);
  const body: LoginTokenErrorBody = http.body;
  if (error.kind === "validation" && isField(error.field)) {
    body.field = error.field;
    body.fieldMessage = error.message;
  }
  if (error.kind === "rate_limited") {
    body.retryAfterSeconds = Number(http.headers?.["Retry-After"] ?? 1);
  }
  return { result: { ok: false, error: body }, status: http.status, headers: http.headers };
}

async function run(
  ports: LoginTokenFnPorts,
  name: string,
  work: () => Promise<Result<void>>,
): Promise<LoginTokenReply> {
  try {
    const result = await work();
    if (result.ok) return { result: { ok: true, value: null }, status: 200 };
    return failure(result.error, ports.ids.uuid());
  } catch (error) {
    const requestId = ports.ids.uuid();
    // The error's name and coded cause only; never its message, which could carry input.
    ports.logger.error("login token server function failed", {
      fn: name,
      requestId,
      ...errorLogFields(error),
    });
    const http = unexpectedToHttp(error, requestId);
    return { result: { ok: false, error: http.body }, status: http.status };
  }
}

export const loadSetupStatus = (ports: LoginTokenFnPorts): Promise<{ initialized: boolean }> =>
  getSetupStatus(ports);

export const runLoginWithToken = (
  ports: LoginTokenFnPorts,
  data: { token: string },
  ip: string | undefined,
  headers: Headers,
) => run(ports, "loginWithToken", () => loginWithToken(ports, { token: data.token, ip }, headers));

export const runRotateLoginToken = (
  ports: LoginTokenFnPorts,
  actor: Actor,
  data: { current: string; token: string; confirm: string },
  ip: string | undefined,
  headers: Headers,
) => run(ports, "rotateLoginToken", () => rotateLoginToken(ports, actor, { ...data, ip }, headers));
