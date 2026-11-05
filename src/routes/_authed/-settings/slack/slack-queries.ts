import { queryOptions } from "@tanstack/react-query";
import type { SlackFnResult } from "../../../../functions/settings-slack.logic";
import { fetchSlackSettings, listSlackChannelsFn } from "../../../../functions/settings-slack";
import { SlackFnError } from "./slack-errors";

export const slackSettingsKeys = {
  all: ["settings", "slack"] as const,
  view: () => ["settings", "slack", "view"] as const,
  channels: () => ["settings", "slack", "channels"] as const,
};

/** Error-as-data to a value, or a thrown `SlackFnError` that keeps the field and request id. */
export async function callSlackFn<T>(promise: Promise<SlackFnResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) return result.value;
  throw new SlackFnError(result.error);
}

/** The Slack section model: status and last 4 of each secret, and the selected channels. */
export const slackSettingsQueryOptions = () =>
  queryOptions({
    queryKey: slackSettingsKeys.view(),
    queryFn: () => callSlackFn(fetchSlackSettings()),
  });

/** The channels the user token is a member of. Each fetch makes up to 10 Slack calls. */
export const slackChannelsQueryOptions = () =>
  queryOptions({
    queryKey: slackSettingsKeys.channels(),
    queryFn: () => callSlackFn(listSlackChannelsFn()),
    staleTime: 60_000,
  });
