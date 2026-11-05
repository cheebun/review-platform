import { z } from "zod";
import {
  finishSetup,
  getSetupSections,
  listSetupGithubRepos,
  testSetupAnthropic,
  testSetupSlack,
  type FinishSetupInput,
  type SetupDeps,
  type SetupError,
  type SetupGithubRepos,
  type SetupSections,
} from "../application/identity/setup";
import type { LlmProbeView } from "../application/settings/llm-settings";
import { MAX_REPOS } from "../domain/settings/repo-entry";
import type { Result } from "../domain/shared/result";
import { errorLogFields, toHttp, unexpectedToHttp, type HttpErrorBody } from "../server/errors";

/*
 * Server-only logic behind src/functions/setup.ts: first-run setup's final submit and the
 * setup-only checks (FR-AUTH-01). Every input is a credential: validators throw fixed messages,
 * errors carry only fixed public text, and nothing from the input is logged.
 */

export type SetupFnPorts = SetupDeps;

/** The fixed public body, plus the wizard field (`token`, `<section>.<field>`) and its message. */
export type SetupErrorBody = HttpErrorBody & {
  field?: string;
  fieldMessage?: string;
  /** `rate_limited` only: whole seconds until the next call is allowed. */
  retryAfterSeconds?: number;
};

export type SetupFnResult<T> = { ok: true; value: T } | { ok: false; error: SetupErrorBody };

/** The result as data, plus the HTTP status and headers the server function sets. */
export type SetupReply<T> = {
  result: SetupFnResult<T>;
  status: number;
  headers?: Record<string, string>;
};

// ---- Input validation (shape and size only; the domain applies the rules) ----

/** Caps each value of the payload. */
export const MAX_SETUP_INPUT = 4096;

const value = z.string().max(MAX_SETUP_INPUT);
const anthropicSchema = z.strictObject({
  apiKey: value.optional(),
  authToken: value.optional(),
  baseUrl: value.optional(),
  model: value.optional(),
});
const githubTokenSchema = z.strictObject({ token: value });
const slackTokenSchema = z.strictObject({ userToken: value });
const finishSchema = z.strictObject({
  token: value,
  confirm: value,
  anthropic: anthropicSchema.optional(),
  github: z
    .strictObject({ token: value, repos: z.array(z.string().max(256)).max(MAX_REPOS) })
    .optional(),
  slack: z.strictObject({ userToken: value, signingSecret: value.optional() }).optional(),
});

function parser<T>(schema: z.ZodType<T>, what: string) {
  return (input: unknown): T => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid ${what}.`);
    return parsed.data;
  };
}

/** Validator for `finishSetup`. */
export const parseFinishSetupBody: (input: unknown) => FinishSetupInput = parser(
  finishSchema,
  "setup input",
);
/** Validator for `testSetupAnthropic`. */
export const parseSetupAnthropicBody = parser(anthropicSchema, "anthropic input");
/** Validator for `listSetupGithubRepos`. */
export const parseGithubTokenBody = parser(githubTokenSchema, "github input");
/** Validator for `testSetupSlack`. */
export const parseSlackTokenBody = parser(slackTokenSchema, "slack input");

// ---- Running a use case ----

function failure(error: SetupError, requestId: string): SetupReply<never> {
  const http = toHttp(error, requestId);
  const body: SetupErrorBody = http.body;
  if (error.field) body.field = error.field;
  // Domain messages here are fixed text (or a repo name that passed the format check).
  if (error.kind === "validation") body.fieldMessage = error.message;
  if (error.kind === "forbidden" && error.field) body.fieldMessage = error.reason;
  if (error.kind === "rate_limited") {
    body.retryAfterSeconds = Number(http.headers?.["Retry-After"] ?? 1);
  }
  return { result: { ok: false, error: body }, status: http.status, headers: http.headers };
}

async function run<T>(
  ports: SetupFnPorts,
  name: string,
  work: () => Promise<Result<T, SetupError>>,
): Promise<SetupReply<T>> {
  try {
    const result = await work();
    if (result.ok) return { result: { ok: true, value: result.value }, status: 200 };
    return failure(result.error, ports.ids.uuid());
  } catch (error) {
    const requestId = ports.ids.uuid();
    // The error's name and coded cause only; never its message, which could carry input.
    ports.logger.error("setup server function failed", {
      fn: name,
      requestId,
      ...errorLogFields(error),
    });
    const http = unexpectedToHttp(error, requestId);
    return { result: { ok: false, error: http.body }, status: http.status };
  }
}

export const runFinishSetup = (
  ports: SetupFnPorts,
  data: FinishSetupInput,
  ip: string | undefined,
  headers: Headers,
): Promise<SetupReply<null>> =>
  run(ports, "finishSetup", async () => {
    const out = await finishSetup(ports, data, ip, headers);
    return out.ok ? { ok: true as const, value: null } : out;
  });

export const runGetSetupSections = (
  ports: SetupFnPorts,
  ip: string | undefined,
): Promise<SetupReply<SetupSections>> =>
  run(ports, "getSetupSections", () => getSetupSections(ports, ip));

export const runTestSetupAnthropic = (
  ports: SetupFnPorts,
  data: z.infer<typeof anthropicSchema>,
  ip: string | undefined,
): Promise<SetupReply<LlmProbeView>> =>
  run(ports, "testSetupAnthropic", () => testSetupAnthropic(ports, data, ip));

export const runListSetupGithubRepos = (
  ports: SetupFnPorts,
  data: { token: string },
  ip: string | undefined,
): Promise<SetupReply<SetupGithubRepos>> =>
  run(ports, "listSetupGithubRepos", () => listSetupGithubRepos(ports, data, ip));

export const runTestSetupSlack = (
  ports: SetupFnPorts,
  data: { userToken: string },
  ip: string | undefined,
): Promise<SetupReply<{ teamName: string }>> =>
  run(ports, "testSetupSlack", () => testSetupSlack(ports, data, ip));
