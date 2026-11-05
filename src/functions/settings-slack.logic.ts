import { z } from "zod";
import type { SlackSettingsDeps } from "../application/settings/slack-deps";
import {
  getSlackSettingsView,
  listSlackChannels,
  removeSlackSecret,
  saveSlackSecret,
  setSlackReviewChannels,
  type SlackChannelList,
  type SlackSettingsView,
} from "../application/settings/slack-settings";
import {
  SLACK_SECRET_FIELD,
  SLACK_SECRET_KINDS,
  type SlackSecretField,
  type SlackSecretKind,
} from "../domain/settings/slack-settings";
import type { Actor } from "../domain/shared/actor";
import type { DomainError, Result } from "../domain/shared/result";
import { errorLogFields, toHttp, unexpectedToHttp, type HttpErrorBody } from "../server/errors";

/*
 * Server-only logic behind src/functions/settings-slack.ts (the Slack section of `/settings`).
 */

/** What these functions read: the use-case deps. Field names match the container's `Ports`. */
export type SlackFnPorts = SlackSettingsDeps;

export type SlackFormField = SlackSecretField | "channels";

/** As `SettingsErrorBody`: a fixed public message, plus the field and its fixed domain message. */
export type SlackSettingsErrorBody = HttpErrorBody & {
  field?: SlackFormField;
  fieldMessage?: string;
  reason?: "needs_reset";
};

export type SlackFnResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SlackSettingsErrorBody };

// ---- Input validation (shape and size only; the domain applies the real rules) ----

/** Generous bounds: they only cap the payload. */
const MAX_SECRET_INPUT = 2000;
const MAX_CHANNEL_INPUT = 500;

const kindSchema = z.enum(SLACK_SECRET_KINDS);
const secretBodySchema = z.strictObject({
  kind: kindSchema,
  value: z.string().max(MAX_SECRET_INPUT),
});
const kindBodySchema = z.strictObject({ kind: kindSchema });
const channelsBodySchema = z.strictObject({
  channels: z.array(z.string().max(64)).max(MAX_CHANNEL_INPUT),
});

/** Validator for `saveSlackSecretFn`. The message is fixed: the value is a credential. */
export function parseSlackSecretBody(input: unknown): { kind: SlackSecretKind; value: string } {
  const parsed = secretBodySchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid Slack secret input.");
  return parsed.data;
}

/** Validator for `removeSlackSecretFn`. */
export function parseSlackSecretKindBody(input: unknown): { kind: SlackSecretKind } {
  const parsed = kindBodySchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid Slack secret kind.");
  return parsed.data;
}

/** Validator for `setSlackChannelsFn`. */
export function parseSlackChannelsBody(input: unknown): { channels: string[] } {
  const parsed = channelsBodySchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid channel selection.");
  return parsed.data;
}

// ---- Running a use case ----

const FIELDS = new Set<string>([...Object.values(SLACK_SECRET_FIELD), "channels"]);
const isFormField = (field: string | undefined): field is SlackFormField =>
  field !== undefined && FIELDS.has(field);

function toBody(
  error: DomainError,
  requestId: string,
  field?: SlackFormField,
): SlackSettingsErrorBody {
  const body: SlackSettingsErrorBody = toHttp(error, requestId).body;
  if (error.kind === "validation" && isFormField(error.field)) {
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
  ports: SlackFnPorts,
  name: string,
  work: (deps: SlackSettingsDeps) => Promise<Result<T>>,
  field?: SlackFormField,
): Promise<SlackFnResult<T>> {
  try {
    const result = await work(ports);
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

export const loadSlackSettings = (ports: SlackFnPorts, actor: Actor) =>
  run<SlackSettingsView>(ports, "fetchSlackSettings", (d) => getSlackSettingsView(d, actor));

export const runSaveSlackSecret = (
  ports: SlackFnPorts,
  actor: Actor,
  data: { kind: SlackSecretKind; value: string },
) =>
  run<SlackSettingsView>(
    ports,
    "saveSlackSecret",
    (d) => saveSlackSecret(d, actor, data),
    SLACK_SECRET_FIELD[data.kind],
  );

export const runRemoveSlackSecret = (
  ports: SlackFnPorts,
  actor: Actor,
  data: { kind: SlackSecretKind },
) => run<SlackSettingsView>(ports, "removeSlackSecret", (d) => removeSlackSecret(d, actor, data));

export const runListSlackChannels = (ports: SlackFnPorts, actor: Actor) =>
  run<SlackChannelList>(ports, "listSlackChannels", (d) => listSlackChannels(d, actor));

export const runSetSlackChannels = (
  ports: SlackFnPorts,
  actor: Actor,
  data: { channels: string[] },
) =>
  run<SlackSettingsView>(
    ports,
    "setSlackChannels",
    (d) => setSlackReviewChannels(d, actor, data),
    "channels",
  );
