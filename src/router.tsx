import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createQueryClient } from "./query-client";
import { routeTree } from "./routeTree.gen";

/** One QueryClient per router: per request on the server, so no data leaks between users. */
export function getRouter() {
  // Late-bound: the QueryClient's error handler navigates with the router created below.
  let router: ReturnType<typeof createAppRouter> | undefined;
  const queryClient = createQueryClient(() => router);
  router = createAppRouter(queryClient);
  // `query-client.ts` owns redirect handling for queries and mutations (and adds the
  // unauthenticated case), so the integration's own redirect wrapper is off.
  setupRouterSsrQueryIntegration({ router, queryClient, handleRedirects: false });
  return router;
}

function createAppRouter(queryClient: ReturnType<typeof createQueryClient>) {
  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // Let TanStack Query own freshness; the router always calls loaders.
    defaultPreloadStaleTime: 0,
  });
}
