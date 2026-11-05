import { z } from "zod";
import type { LlmSettingsDeps } from "../application/settings/llm-deps";
import {
  getLlmSettingsView,
  removeAnthropicSettings,
  saveAnthropicSettings,
  testAnthropicSettings,
  type LlmSaveResult,
  type LlmSettingsView,
  type LlmTestResult,
} from "../application/settings/llm-settings";
import type { LlmField } from "../domain/settings/llm-settings";
import type { Actor } from "../domain/shared/actor";
import type { DomainError, Result } from "../domain/shared/result";
import { errorLogFields, toHttp, unexpectedToHttp, type HttpErrorBody } from "../server/errors";

/*
 * Server-only logic behind src/functions/settings-llm.ts (the LLM section of `/settings`).
 */

/** What these functions read: the use-case deps. Field names match the container's `Ports`. */
export type LlmFnPorts = LlmSettingsDeps;

/** As `SlackSettingsErrorBody`: a fixed public message, plus the field and its fixed message. */
export type LlmSettingsErrorBody = HttpErrorBody & {
  field?: LlmField;
  fieldMessage?: string;
  reason?: "needs_reset";
};

export type LlmFnResult<T> = { ok: true; value: T } | { ok: false; error: LlmSettingsErrorBody };

// ---- Input validation (shape and size only; the domain applies the real rules) ----

const MAX_SECRET_INPUT = 2000;
const MAX_URL_INPUT = 2100;
const MAX_SHORT_INPUT = 300;

const anthropicSchema = z.strictObject({
  baseUrl: z.string().max(MAX_URL_INPUT).optional(),
  model: z.string().max(MAX_SHORT_INPUT).optional(),
  apiKey: z.string().max(MAX_SECRET_INPUT).optional(),
  authToken: z.string().max(MAX_SECRET_INPUT).optional(),
});
const sectionSchema = z.strictObject({ section: z.literal("anthropic") });

export type AnthropicBody = z.infer<typeof anthropicSchema>;
export type LlmSectionBody = z.infer<typeof sectionSchema>;

/** Validator for `saveAnthropicSettingsFn`. The message is fixed: the body holds a credential. */
export function parseAnthropicBody(input: unknown): AnthropicBody {
  const parsed = anthropicSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid Anthropic settings input.");
  return parsed.data;
}

export function parseLlmSectionBody(input: unknown): LlmSectionBody {
  const parsed = sectionSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid LLM section.");
  return parsed.data;
}

// ---- Running a use case ----

const FIELDS = new Set<string>([
  "baseUrl",
  "model",
  "apiKey",
  "authToken",
  "credential",
] satisfies LlmField[]);
const isField = (field: string | undefined): field is LlmField =>
  field !== undefined && FIELDS.has(field);

function toBody(error: DomainError & { field?: string }, requestId: string): LlmSettingsErrorBody {
  const body: LlmSettingsErrorBody = toHttp(error, requestId).body;
  if (error.kind === "validation" && isField(error.field)) {
    body.field = error.field;
    body.fieldMessage = error.message;
  } else if (error.kind === "forbidden" && isField(error.field)) {
    body.field = error.field;
    body.fieldMessage = error.reason;
  }
  if (error.kind === "not_configured" && error.reason) body.reason = error.reason;
  return body;
}

async function run<T>(
  ports: LlmFnPorts,
  name: string,
  work: (deps: LlmSettingsDeps) => Promise<Result<T>>,
): Promise<LlmFnResult<T>> {
  try {
    const result = await work(ports);
    if (result.ok) return result;
    return { ok: false, error: toBody(result.error, ports.ids.uuid()) };
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

export const loadLlmSettings = (ports: LlmFnPorts, actor: Actor) =>
  run<LlmSettingsView>(ports, "fetchLlmSettings", (d) => getLlmSettingsView(d, actor));

export const runSaveAnthropic = (ports: LlmFnPorts, actor: Actor, data: AnthropicBody) =>
  run<LlmSaveResult>(ports, "saveAnthropicSettings", (d) => saveAnthropicSettings(d, actor, data));

export const runTestAnthropic = (ports: LlmFnPorts, actor: Actor, data: AnthropicBody) =>
  run<LlmTestResult>(ports, "testAnthropicSettings", (d) => testAnthropicSettings(d, actor, data));

export const runRemoveLlmSection = (ports: LlmFnPorts, actor: Actor, _data: LlmSectionBody) =>
  run<LlmSettingsView>(ports, "removeLlmSection", (d) => removeAnthropicSettings(d, actor));
