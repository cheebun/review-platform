import { createFileRoute } from "@tanstack/react-router";
import { prefetchSafe } from "../../query-client";
import { MergePage } from "./-merge/merge-page";
import { mergeHistoryQueryOptions, mergeQueueQueryOptions } from "./-merge/queries";

export const Route = createFileRoute("/_authed/merge")({
  head: () => ({ meta: [{ title: "Merge · Review platform" }] }),
  loader: async ({ context }) => {
    // Prefetch only: a failure is shown by the page's own error states, not the route boundary.
    // A redirect (the session expired) propagates.
    const { queryClient } = context;
    await Promise.all([
      prefetchSafe(queryClient, mergeQueueQueryOptions()),
      prefetchSafe(queryClient, mergeHistoryQueryOptions()),
    ]);
  },
  component: MergePage,
});
