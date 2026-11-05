import { queryOptions } from "@tanstack/react-query";
import { fetchMergeGates, fetchMergeHistory, fetchMergeQueue } from "../../../functions/merge";
import { unwrapFnResult } from "../../../queries/fn-result";

export const HISTORY_PAGE = 20;
export const HISTORY_MAX = 100;

export const mergeKeys = {
  all: ["merge"] as const,
  queue: () => ["merge", "queue"] as const,
  gates: (prUrl: string) => ["merge", "gates", prUrl] as const,
  history: (limit?: number) =>
    limit === undefined ? (["merge", "history"] as const) : (["merge", "history", limit] as const),
};

/** Reviewed PRs awaiting merge, with the GitHub configuration state. */
export const mergeQueueQueryOptions = () =>
  queryOptions({
    queryKey: mergeKeys.queue(),
    queryFn: async () => unwrapFnResult(await fetchMergeQueue()),
  });

/** One PR's live gate checklist. Always fetched fresh: gates are live GitHub state. */
export const mergeGatesQueryOptions = (prUrl: string) =>
  queryOptions({
    queryKey: mergeKeys.gates(prUrl),
    queryFn: async () => unwrapFnResult(await fetchMergeGates({ data: { prUrl } })),
    staleTime: 0,
  });

/**
 * The newest `limit` merges. The server has no cursor for events, so "load more" asks for a
 * larger window (capped by the server at 100).
 */
export const mergeHistoryQueryOptions = (limit: number = HISTORY_PAGE) =>
  queryOptions({
    queryKey: mergeKeys.history(limit),
    queryFn: async () => unwrapFnResult(await fetchMergeHistory({ data: { limit } })),
  });
