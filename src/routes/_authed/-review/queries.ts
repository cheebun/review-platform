import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { fetchReviewDetail, fetchReviewList } from "../../../functions/review";
import { FnRequestError, unwrapFnResult } from "../../../queries/fn-result";
import type { ReviewSearch } from "./search";

export const reviewKeys = {
  all: ["review"] as const,
  list: (search: ReviewSearch) => ["review", "list", search] as const,
  detail: (id: string) => ["review", "detail", id] as const,
};

/** Only the filters that are set, so the server's strict validator sees no stray keys. */
const definedOnly = (search: ReviewSearch): ReviewSearch =>
  Object.fromEntries(Object.entries(search).filter(([, v]) => v !== undefined)) as ReviewSearch;

/** Review history, newest first, paged by the server's opaque cursor. */
export const reviewListQueryOptions = (search: ReviewSearch) => {
  const filters = definedOnly(search);
  return infiniteQueryOptions({
    queryKey: reviewKeys.list(filters),
    queryFn: async ({ pageParam }) =>
      unwrapFnResult(
        await fetchReviewList({
          data: pageParam === undefined ? filters : { ...filters, cursor: pageParam },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};

export const isNotFound = (error: unknown) =>
  error instanceof FnRequestError && error.kind === "not_found";

/** One review record. A `not_found` is final, so it is not retried. */
export const reviewDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: reviewKeys.detail(id),
    queryFn: async () => unwrapFnResult(await fetchReviewDetail({ data: { id } })),
    retry: (failures, error) => !isNotFound(error) && failures < 1,
    retryDelay: 300,
  });
