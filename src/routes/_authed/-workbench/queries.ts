import { queryOptions } from "@tanstack/react-query";
import {
  fetchMergeSummary,
  fetchReviewSummary,
  fetchSetupStatus,
} from "../../../functions/workbench";
import { unwrapFnResult } from "../../../queries/fn-result";

export const workbenchKeys = {
  all: ["workbench"] as const,
  reviews: () => ["workbench", "reviews"] as const,
  merge: () => ["workbench", "merge"] as const,
  setup: () => ["workbench", "setup"] as const,
};

/** Review counts over the last 7 UTC+8 days and the latest reviews. */
export const reviewSummaryQueryOptions = () =>
  queryOptions({
    queryKey: workbenchKeys.reviews(),
    queryFn: async () => unwrapFnResult(await fetchReviewSummary()),
  });

/** Reviewed PRs awaiting merge, counted from stored records. */
export const mergeSummaryQueryOptions = () =>
  queryOptions({
    queryKey: workbenchKeys.merge(),
    queryFn: async () => unwrapFnResult(await fetchMergeSummary()),
  });

/** Configuration state per /settings section. */
export const setupStatusQueryOptions = () =>
  queryOptions({
    queryKey: workbenchKeys.setup(),
    queryFn: async () => unwrapFnResult(await fetchSetupStatus()),
  });
