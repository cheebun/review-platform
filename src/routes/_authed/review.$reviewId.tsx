import { createFileRoute, isRedirect, notFound } from "@tanstack/react-router";
import { isNotFound, reviewDetailQueryOptions } from "./-review/queries";
import { ReviewDetailPage, ReviewNotFound } from "./-review/review-detail-page";

export const Route = createFileRoute("/_authed/review/$reviewId")({
  head: () => ({ meta: [{ title: "Review detail · Review platform" }] }),
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(reviewDetailQueryOptions(params.reviewId));
    } catch (error) {
      // A redirect (the session expired) propagates. An unknown id is a real 404 (status and
      // view); any other failure is the page's own state.
      if (isRedirect(error)) throw error;
      if (isNotFound(error)) throw notFound();
    }
  },
  notFoundComponent: ReviewNotFound,
  component: ReviewDetailRoute,
});

function ReviewDetailRoute() {
  const { reviewId } = Route.useParams();
  return <ReviewDetailPage reviewId={reviewId} />;
}
