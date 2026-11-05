import { createFileRoute } from "@tanstack/react-router";
import { settingsQueryOptions } from "../../queries/settings";
import { prefetchSafe } from "../../query-client";
import { llmSettingsQueryOptions } from "./-settings/llm/llm-queries";
import { SettingsPage } from "./-settings/settings-page";
import { slackSettingsQueryOptions } from "./-settings/slack/slack-queries";

export const Route = createFileRoute("/_authed/settings")({
  head: () => ({ meta: [{ title: "Settings · Review platform" }] }),
  loader: async ({ context }) => {
    // Prefetch only: a failure is shown by each section's own error state, not the route boundary.
    // A redirect (the session expired) propagates.
    const { queryClient } = context;
    await Promise.all([
      prefetchSafe(queryClient, settingsQueryOptions()),
      prefetchSafe(queryClient, slackSettingsQueryOptions()),
      prefetchSafe(queryClient, llmSettingsQueryOptions()),
    ]);
  },
  component: SettingsPage,
});
