import type { TanStackDevtoolsReactPlugin } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Loads the panels of the dev-only TanStack Devtools shell (Query, Router and Form) and returns
 * a function that builds them for a QueryClient. Dynamic imports, so the root route can drop the
 * whole module from production builds. The Query panel gets the router's QueryClient explicitly,
 * so it does not depend on where the QueryClientProvider sits relative to the shell.
 */
export async function loadDevtoolsPlugins(): Promise<
  (client: QueryClient) => TanStackDevtoolsReactPlugin[]
> {
  const [{ ReactQueryDevtoolsPanel }, { TanStackRouterDevtoolsPanel }, { formDevtoolsPlugin }] =
    await Promise.all([
      import("@tanstack/react-query-devtools"),
      import("@tanstack/react-router-devtools"),
      import("@tanstack/react-form-devtools"),
    ]);
  return (client) => [
    { name: "TanStack Query", render: <ReactQueryDevtoolsPanel client={client} /> },
    { name: "TanStack Router", render: <TanStackRouterDevtoolsPanel /> },
    formDevtoolsPlugin(),
  ];
}
