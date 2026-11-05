import { addRepo, removeRepo, type AddRepoResult } from "../application/settings/repos";
import { removeGithubToken, saveGithubToken } from "../application/settings/github-token";
import { getSettingsView, type SettingsView } from "../application/settings/view";
import type { Actor } from "../domain/shared/actor";
import type { DomainError, Result } from "../domain/shared/result";
import type { Ports } from "../server/container";
import { errorLogFields, toHttp, unexpectedToHttp, type HttpErrorBody } from "../server/errors";

/**
 * Error body of a settings server function. On top of the fixed public message (S4), a form
 * error names its `field` and carries the domain's `fieldMessage`. Domain validation messages
 * are fixed strings that never include the input, so they are safe to show.
 */
export type SettingsErrorBody = HttpErrorBody & {
  field?: "token" | "repo";
  fieldMessage?: string;
  /** `not_configured` only: a token is stored but cannot be decrypted. */
  reason?: "needs_reset";
};

export type SettingsFnResult<T> = { ok: true; value: T } | { ok: false; error: SettingsErrorBody };

/** Generous bounds: the domain applies the real rules; this only caps the payload. */
const MAX_TOKEN_INPUT = 2000;
const MAX_REPO_INPUT = 500;

function stringField(input: unknown, field: string, max: number): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid input.");
  }
  const value = (input as Record<string, unknown>)[field];
  // Never include the value in the message: for `token` it is a credential.
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${field}.`);
  return value;
}

/** Validator for `saveGithubTokenFn`. */
export function parseTokenBody(input: unknown): { token: string } {
  return { token: stringField(input, "token", MAX_TOKEN_INPUT) };
}

/** Validator for `addRepoFn` and `removeRepoFn`. */
export function parseRepoBody(input: unknown): { repo: string } {
  return { repo: stringField(input, "repo", MAX_REPO_INPUT) };
}

type FormField = "token" | "repo";

/**
 * `field` is the form input a function belongs to. Its validation errors, and its `forbidden`
 * (token rejected, repo unreachable), are shown on that input. Both texts are fixed strings set
 * by the use cases; neither carries the token or a GitHub response body.
 */
function toBody(error: DomainError, requestId: string, field?: FormField): SettingsErrorBody {
  const body: SettingsErrorBody = toHttp(error, requestId).body;
  if (error.kind === "validation" && (error.field === "token" || error.field === "repo")) {
    body.field = error.field;
    body.fieldMessage = error.message;
  } else if (error.kind === "forbidden" && field) {
    body.field = field;
    body.fieldMessage = error.reason;
  }
  if (error.kind === "not_configured" && error.reason) body.reason = error.reason;
  return body;
}

async function run<T>(
  ports: Ports,
  name: string,
  work: () => Promise<Result<T>>,
  field?: FormField,
): Promise<SettingsFnResult<T>> {
  try {
    const result = await work();
    if (result.ok) return result;
    return { ok: false, error: toBody(result.error, ports.ids.uuid(), field) };
  } catch (error) {
    const requestId = ports.ids.uuid();
    // Name plus the coded cause (Postgres SQLSTATE); never the message, params or query.
    ports.logger.error("settings server function failed", {
      fn: name,
      requestId,
      ...errorLogFields(error),
    });
    return { ok: false, error: unexpectedToHttp(error, requestId).body };
  }
}

export const loadSettings = (ports: Ports, actor: Actor) =>
  run<SettingsView>(ports, "fetchSettings", () => getSettingsView(ports, actor));

export const runSaveGithubToken = (ports: Ports, actor: Actor, data: { token: string }) =>
  run<SettingsView>(ports, "saveGithubToken", () => saveGithubToken(ports, actor, data), "token");

export const runRemoveGithubToken = (ports: Ports, actor: Actor) =>
  run<SettingsView>(ports, "removeGithubToken", () => removeGithubToken(ports, actor));

export const runAddRepo = (ports: Ports, actor: Actor, data: { repo: string }) =>
  run<AddRepoResult>(ports, "addRepo", () => addRepo(ports, actor, data), "repo");

export const runRemoveRepo = (ports: Ports, actor: Actor, data: { repo: string }) =>
  run<SettingsView>(ports, "removeRepo", () => removeRepo(ports, actor, data));
