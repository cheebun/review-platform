/**
 * Recognises a server function's input-validator failure, so `authed` can answer it with a
 * `validation` / 400 instead of an `internal` / 500.
 *
 * Start runs the validator inside the function middleware chain (after `authed`, right before the
 * handler), so its throw reaches `authed` exactly like a handler's throw. What a validator throws:
 * - the project's validators (`src/functions/*.logic.ts`): a plain `Error` with a fixed message
 *   `Invalid <what>.` that never echoes the input;
 * - a zod schema passed directly (`.parse`): a `ZodError`;
 * - a Standard Schema validator: Start throws `new Error(JSON.stringify(issues))`.
 *
 * Only these shapes count. A subclass (`TypeError("Invalid URL")`, an SDK or driver error) or any
 * other message stays an unexpected failure. The thrown error's message and issues are never
 * forwarded: the response carries the fixed public message only (S4), because zod issues and
 * Standard Schema messages can contain the submitted value (a token, for example).
 */

/** The project convention: `Invalid` + a short fixed description + `.` on one line. */
const PROJECT_VALIDATOR_MESSAGE = /^Invalid [^\n]{1,80}\.$/;
const MAX_ISSUES_JSON = 64 * 1024;

function isPlainError(error: unknown): error is Error {
  return error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
}

function isZodError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

/** Start's `execValidator` for a Standard Schema: a JSON array of `{ message, ... }` issues. */
function isStandardSchemaFailure(message: string): boolean {
  if (!message.startsWith("[") || message.length > MAX_ISSUES_JSON) return false;
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return false;
  }
  return (
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every(
      (issue) =>
        issue !== null &&
        typeof issue === "object" &&
        typeof (issue as { message?: unknown }).message === "string",
    )
  );
}

export function isValidatorFailure(error: unknown): boolean {
  if (isZodError(error)) return true;
  if (!isPlainError(error)) return false;
  return PROJECT_VALIDATOR_MESSAGE.test(error.message) || isStandardSchemaFailure(error.message);
}
