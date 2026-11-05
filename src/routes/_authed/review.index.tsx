import { createFileRoute, isRedirect } from "@tanstack/react-router";
import { reviewListQueryOptions } from "./-review/queries";
import { ReviewListPage } from "./-review/review-list-page";
import { validateReviewSearch, type ReviewSearch } from "./-review/search";

export const Route = createFileRoute("/_authed/review/")({
  head: () => ({ meta: [{ title: "Review · Review platform" }] }),
  validateSearch: validateReviewSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    // Prefetch only: a failure is shown by the page's own error state, not the route boundary.
    // A redirect (the session expired) propagates. The `prefetchSafe` policy for an infinite query:
    // `ensureInfiniteQueryData`, because `prefetchInfiniteQuery` swallows redirects too.
    try {
      await context.queryClient.ensureInfiniteQueryData(reviewListQueryOptions(deps));
    } catch (error) {
      if (isRedirect(error)) throw error;
    }
  },
  component: ReviewRoute,
});

function ReviewRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ReviewListPage
      search={search}
      onSearchChange={(next: ReviewSearch) => void navigate({ search: next, replace: true })}
    />
  );
}
