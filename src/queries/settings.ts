import { queryOptions } from "@tanstack/react-query";
import { fetchSettings } from "../functions/settings";
import { unwrapFnResult } from "./fn-result";

export const settingsKeys = {
  all: ["settings"] as const,
  view: () => ["settings", "view"] as const,
};

/** The /settings page model: GitHub availability, token display and the repo list. */
export const settingsQueryOptions = () =>
  queryOptions({
    queryKey: settingsKeys.view(),
    queryFn: async () => unwrapFnResult(await fetchSettings()),
  });
