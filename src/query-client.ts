/**
 * The app's QueryClient and the global handling of failed queries and mutations.
 *
 * A server function call can reject outside a navigation: a background refetch, a mutation, or a
 * query a component starts. The router only follows a `redirect` thrown from a loader or
 * `beforeLoad`, so this module does it for the rest:
 * - a router `redirect` is navigated to;
 * - an unauthenticated error (the session expired) navigates to `/login?redirect=<current page>`;
 * - everything else stays with the query or mutation (`isError`, `onError`).
 *
 * Neither is retried: retrying a redirect or a missing session only delays the navigation.
 * (Mutations keep TanStack Query's default of no retries.)
 */
import {
  MutationCache,
  QueryCache,
  QueryClient,
  type FetchQueryOptions,
  type QueryKey,
} from "@tanstack/react-query";
import { isRedirect, type AnyRedirect } from "@tanstack/react-router";
import { LOGIN_PATH, isUnauthenticatedError, loginHref } from "./server/middleware/server-fn-error";

/** The slice of the router the handler needs (structural, so tests can pass a fake). */
export interface ErrorNavigator {
  navigate: (options: { href: string; replace?: boolean }) => unknown;
  resolveRedirect: (redirect: AnyRedirect) => AnyRedirect;
  state: { location: { href: string; pathname: string } };
}

const MAX_RETRIES = 1;

function swallow(result: unknown): void {
  if (result instanceof Promise) result.catch(() => undefined);
}

/**
 * The `onError` for the QueryCache and MutationCache. `getRouter` is late-bound: the QueryClient
 * is created before the router that uses it. Never throws (it runs inside TanStack Query).
 */
export function createGlobalErrorHandler(
  getRouter: () => ErrorNavigator | undefined,
): (error: unknown) => void {
  return (error) => {
    const router = getRouter();
    if (!router) return;
    try {
      if (isRedirect(error)) {
        const { options } = router.resolveRedirect(error);
        swallow(router.navigate({ ...options, href: options.href ?? LOGIN_PATH, replace: true }));
        return;
      }
      if (isUnauthenticatedError(error)) {
        const { href, pathname } = router.state.location;
        if (pathname.toLowerCase() === LOGIN_PATH) return;
        swallow(router.navigate({ href: loginHref(href), replace: true }));
      }
    } catch {
      // An unsafe redirect target (resolveRedirect refuses it) is dropped; the query keeps its error.
    }
  };
}

/** No retry for a redirect or a missing session; any other failure is retried once. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isRedirect(error) || isUnauthenticatedError(error)) return false;
  return failureCount < MAX_RETRIES;
}

/** One QueryClient per router: per request on the server, so no data leaks between users. */
export function createQueryClient(getRouter: () => ErrorNavigator | undefined): QueryClient {
  const onError = createGlobalErrorHandler(getRouter);
  return new QueryClient({
    queryCache: new QueryCache({ onError: (error) => onError(error) }),
    mutationCache: new MutationCache({ onError: (error) => onError(error) }),
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry },
      // The SSR integration dehydrates every query by default. A failed one holds its error in
      // `state.error`, which can be a router redirect (a `Response`, which seroval cannot
      // serialize). The browser refetches it instead.
      dehydrate: { shouldDehydrateQuery: (query) => query.state.status !== "error" },
    },
  });
}

/**
 * A loader prefetch whose failure does not fail the route: the component shows the query's own
 * error state. A router `redirect` (for example the session expired) is re-thrown so the loader
 * propagates it. Uses `ensureQueryData`, because `prefetchQuery` swallows every error, redirects
 * included.
 */
export async function prefetchSafe<TQueryFnData, TError, TData, TQueryKey extends QueryKey>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): Promise<void> {
  try {
    await queryClient.ensureQueryData(options);
  } catch (error) {
    if (isRedirect(error)) throw error;
  }
}
