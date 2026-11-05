import { lazy, Suspense, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  ClientOnly,
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import appCss from "../styles/app.css?url";

/** Typed router context. `getRouter` (src/router.tsx) provides it: one QueryClient per router. */
export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * One TanStack Devtools shell, dev only, with the Query, Router and Form panels (`-devtools.tsx`).
 * `import.meta.env.DEV` is a build-time constant, so in a production build the branch and its
 * dynamic imports are removed and no devtools code ships.
 */
const Devtools = import.meta.env.DEV
  ? lazy(async () => {
      const [{ TanStackDevtools }, { loadDevtoolsPlugins }] = await Promise.all([
        import("@tanstack/react-devtools"),
        import("./-devtools"),
      ]);
      const buildPlugins = await loadDevtoolsPlugins();
      return {
        default: ({ queryClient }: { queryClient: QueryClient }) => (
          <TanStackDevtools plugins={buildPlugins(queryClient)} />
        ),
      };
    })
  : null;

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Review platform" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => <Outlet />,
  shellComponent: RootShell,
});

function RootShell({ children }: Readonly<{ children: ReactNode }>) {
  const { queryClient } = Route.useRouteContext();
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {Devtools ? (
          <ClientOnly>
            <Suspense fallback={null}>
              <Devtools queryClient={queryClient} />
            </Suspense>
          </ClientOnly>
        ) : null}
        <Scripts />
      </body>
    </html>
  );
}
