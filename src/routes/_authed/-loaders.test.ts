/**
 * The `_authed` route loaders only prefetch: a failed query is shown by the card or section's own
 * error state, but a router `redirect` (for example the session expired) must propagate so the
 * router navigates to it.
 */
import { QueryClient } from "@tanstack/react-query";
import { isRedirect, redirect } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { ServerFnError } from "../../server/middleware/server-fn-error";
import { getRouter } from "../../router";
import { Route as IndexRoute } from "./index";
import { Route as MergeRoute } from "./merge";
import { Route as ReviewDetailRoute } from "./review.$reviewId";
import { Route as ReviewListRoute } from "./review.index";
import { Route as SettingsRoute } from "./settings";

type Loader = (ctx: Record<string, unknown>) => Promise<unknown>;

interface Case {
  name: string;
  route: { options: { loader?: unknown } };
  deps?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

const cases: Case[] = [
  { name: "/ (overview)", route: IndexRoute },
  { name: "/settings", route: SettingsRoute },
  { name: "/merge", route: MergeRoute },
  { name: "/review", route: ReviewListRoute, deps: {} },
  { name: "/review/$reviewId", route: ReviewDetailRoute, params: { reviewId: "r-1" } },
];

const internal = () =>
  new ServerFnError({
    kind: "internal",
    message: "Internal server error.",
    requestId: "r-2",
    status: 500,
  });

/** A QueryClient whose every fetch rejects with `error` (no server function is ever called). */
function failingClient(error: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const reject = async () => Promise.reject(error);
  for (const method of [
    "ensureQueryData",
    "ensureInfiniteQueryData",
    "fetchQuery",
    "fetchInfiniteQuery",
    "prefetchQuery",
    "prefetchInfiniteQuery",
  ] as const) {
    vi.spyOn(queryClient, method).mockImplementation(reject as never);
  }
  return queryClient;
}

function runLoader(c: Case, error: unknown) {
  const loader = c.route.options.loader as Loader;
  return loader({
    context: { queryClient: failingClient(error) },
    deps: c.deps ?? {},
    params: c.params ?? {},
    abortController: new AbortController(),
  });
}

describe.each(cases)("$name loader", (c) => {
  it("throws the redirect when a prefetch throws one", async () => {
    const r = redirect({ href: "/login?redirect=%2F" });
    const outcome = await runLoader(c, r).then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(isRedirect(outcome)).toBe(true);
    expect(outcome).toBe(r);
  });

  it("resolves when a prefetch throws an ordinary error", async () => {
    await expect(runLoader(c, internal())).resolves.toBeUndefined();
    await expect(runLoader(c, new Error("boom"))).resolves.toBeUndefined();
  });
});

it("removed page and API paths resolve only to the guarded catch-all", () => {
  const router = getRouter();
  for (const path of [
    "/jira",
    "/api/jira/breakdown",
    "/slack",
    "/api/slack/digest",
    "/api/slack/digest/read",
    "/api/slack/review-drain",
  ]) {
    expect(router.matchRoutes(path).map((match) => match.routeId)).toEqual(["__root__", "/$"]);
  }
});
