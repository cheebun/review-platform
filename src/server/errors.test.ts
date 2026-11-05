import { describe, expect, it } from "vitest";
import { err, isErr, isOk, ok, type DomainError } from "../domain/shared/result";
import { errorLogFields, toHttp, unexpectedToHttp } from "./errors";

const SECRET = "internal-detail-xyz postgresql://u:p@h/db";

const cases: [DomainError, number][] = [
  [{ kind: "validation", field: "repo", message: SECRET }, 400],
  [{ kind: "unauthenticated" }, 401],
  [{ kind: "forbidden", reason: SECRET }, 403],
  [{ kind: "not_found", entity: SECRET }, 404],
  [{ kind: "conflict", reason: SECRET }, 409],
  [{ kind: "deferred", resumeToken: SECRET }, 202],
  [{ kind: "rate_limited", retryAfterMs: 1200 }, 429],
  [{ kind: "upstream", service: "github", retryable: true }, 503],
  [{ kind: "upstream", service: "llm", retryable: false }, 502],
  [{ kind: "not_configured", feature: "llm" }, 503],
];

describe("toHttp", () => {
  it.each(cases)("maps %j to %i with no internal leak", (error, status) => {
    const { body } = toHttp(error, "req-1");
    expect(toHttp(error, "req-1").status).toBe(status);
    expect(body.requestId).toBe("req-1");
    expect(body.kind).toBe(error.kind);
    expect(body.message.length).toBeGreaterThan(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("internal-detail");
    expect(raw).not.toContain("postgresql://");
    expect(raw).not.toContain("repo");
  });

  it("uses a fixed message per kind", () => {
    const a = toHttp({ kind: "conflict", reason: "a" }, "1").body.message;
    const b = toHttp({ kind: "conflict", reason: "b" }, "2").body.message;
    expect(a).toBe(b);
  });

  it("adds Retry-After (whole seconds, rounded up) only for rate_limited", () => {
    expect(toHttp({ kind: "rate_limited", retryAfterMs: 1200 }, "r").headers).toEqual({
      "Retry-After": "2",
    });
    expect(toHttp({ kind: "rate_limited", retryAfterMs: 0 }, "r").headers?.["Retry-After"]).toBe(
      "1",
    );
    expect(toHttp({ kind: "unauthenticated" }, "r").headers).toBeUndefined();
  });
});

describe("unexpectedToHttp", () => {
  it("returns a generic 500 without the error message or cause", () => {
    const e = new Error(SECRET, { cause: new Error("cause-secret") });
    const res = unexpectedToHttp(e, "req-9");
    expect(res.status).toBe(500);
    expect(res.body.requestId).toBe("req-9");
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("internal-detail");
    expect(raw).not.toContain("cause-secret");
    expect(unexpectedToHttp("string thrown", "x").status).toBe(500);
  });
});

describe("Result helpers", () => {
  it("ok / err", () => {
    const a = ok(1);
    const b = err({ kind: "unauthenticated" } as const);
    expect(isOk(a) && a.value).toBe(1);
    expect(isErr(b) && b.error.kind).toBe("unauthenticated");
    expect(isOk(b)).toBe(false);
  });
});

/** Mirrors drizzle's DrizzleQueryError: the message embeds the SQL and its params. */
function drizzleError(cause: unknown): Error {
  const e = new Error(
    `Failed query: select * from "setting_secret" where token = $1\nparams: ${SECRET}`,
  );
  e.name = "DrizzleQueryError";
  (e as Error & { params: unknown[]; cause: unknown }).params = [SECRET];
  (e as Error & { cause: unknown }).cause = cause;
  return e;
}
function pgError(code: string, message: string): Error {
  const e = new Error(message);
  e.name = "PostgresError";
  Object.assign(e, { code, detail: `Key (token)=(${SECRET}) already exists.` });
  return e;
}

describe("errorLogFields", () => {
  it("surfaces the Postgres code and message behind a DrizzleQueryError", () => {
    const fields = errorLogFields(
      drizzleError(pgError("42P01", 'relation "setting_secret" does not exist')),
    );
    expect(fields).toEqual({
      error: "DrizzleQueryError",
      causeName: "PostgresError",
      causeCode: "42P01",
      causeMessage: 'relation "setting_secret" does not exist',
    });
  });

  it("never logs the query, params, detail or values after a colon", () => {
    const fields = errorLogFields(
      drizzleError(pgError("22P02", `invalid input syntax for type uuid: "${SECRET}"`)),
    );
    expect(fields.causeCode).toBe("22P02");
    expect(fields.causeMessage).toBe("invalid input syntax for type uuid");
    const raw = JSON.stringify(fields);
    expect(raw).not.toContain("internal-detail");
    expect(raw).not.toContain("postgresql://");
    expect(raw).not.toContain("Failed query");
    expect(raw).not.toContain("$1");
  });

  it("redacts the role name of an auth failure", () => {
    const fields = errorLogFields(
      drizzleError(pgError("28P01", 'password authentication failed for user "avnadmin"')),
    );
    expect(fields.causeCode).toBe("28P01");
    expect(fields.causeMessage).toBe('password authentication failed for user "[REDACTED]"');
  });

  it("keeps only the code of a non-SQLSTATE cause (its message can name the host)", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432"), {
      code: "ECONNREFUSED",
    });
    expect(errorLogFields(drizzleError(cause))).toEqual({
      error: "DrizzleQueryError",
      causeName: "Error",
      causeCode: "ECONNREFUSED",
    });
  });

  it("logs only the name for an error without a cause, and 'unknown' for a non-error", () => {
    expect(errorLogFields(new TypeError(SECRET))).toEqual({ error: "TypeError" });
    expect(errorLogFields(SECRET)).toEqual({ error: "unknown" });
  });
});
