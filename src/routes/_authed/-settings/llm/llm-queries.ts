import { queryOptions } from "@tanstack/react-query";
import { fetchLlmSettings } from "../../../../functions/settings-llm";
import type { LlmFnResult } from "../../../../functions/settings-llm.logic";
import { LlmFnError } from "./llm-errors";

export const llmSettingsKeys = {
  all: ["settings", "llm"] as const,
  view: () => ["settings", "llm", "view"] as const,
};

/** Error-as-data to a value, or a thrown `LlmFnError` that keeps the field and request id. */
export async function callLlmFn<T>(promise: Promise<LlmFnResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) return result.value;
  throw new LlmFnError(result.error);
}

/** Anthropic settings and masked credential metadata; never the stored secret. */
export const llmSettingsQueryOptions = () =>
  queryOptions({
    queryKey: llmSettingsKeys.view(),
    queryFn: () => callLlmFn(fetchLlmSettings()),
  });
