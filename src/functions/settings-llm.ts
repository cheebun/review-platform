import { createServerFn } from "@tanstack/react-start";
import { authed } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import {
  loadLlmSettings,
  parseAnthropicBody,
  parseLlmSectionBody,
  runRemoveLlmSection,
  runSaveAnthropic,
  runTestAnthropic,
  type LlmFnPorts,
} from "./settings-llm.logic";

const llmPorts = async (): Promise<LlmFnPorts> => (await getContainer()).ports;

/** The LLM section model: the active provider, settings and the last 4 of each key. */
export const fetchLlmSettings = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async ({ context }) => loadLlmSettings(await llmPorts(), context.actor));

/** Validates and persists encrypted settings without contacting the provider. */
export const saveAnthropicSettingsFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseAnthropicBody)
  .handler(async ({ data, context }) => runSaveAnthropic(await llmPorts(), context.actor, data));

/** Tests submitted values without saving them; a pass on the saved values marks them verified. */
export const testAnthropicSettingsFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseAnthropicBody)
  .handler(async ({ data, context }) => runTestAnthropic(await llmPorts(), context.actor, data));

/** Removes one provider's credential and values. */
export const removeLlmSectionFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseLlmSectionBody)
  .handler(async ({ data, context }) => runRemoveLlmSection(await llmPorts(), context.actor, data));
