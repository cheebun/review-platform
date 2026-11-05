import { createFileRoute } from "@tanstack/react-router";
import { prefetchSafe } from "../../query-client";
import {
  mergeSummaryQueryOptions,
  reviewSummaryQueryOptions,
  setupStatusQueryOptions,
} from "./-workbench/queries";
import { WorkbenchPage } from "./-workbench/workbench-page";

export const Route = createFileRoute("/_authed/")({
  head: () => ({ meta: [{ title: "Overview · Review platform" }] }),
  loader: async ({ context }) => {
    // Prefetch only: a failure is shown by that card's own error state, not the route boundary.
    // A redirect (the session expired) propagates.
    const { queryClient } = context;
    await Promise.all([
      prefetchSafe(queryClient, reviewSummaryQueryOptions()),
      prefetchSafe(queryClient, mergeSummaryQueryOptions()),
      prefetchSafe(queryClient, setupStatusQueryOptions()),
    ]);
  },
  component: WorkbenchPage,
});
