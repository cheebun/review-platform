import { notFound, redirect } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { FnRequestError } from "./queries/fn-result";
import {
  createGlobalErrorHandler,
  createQueryClient,
  prefetchSafe,
  shouldRetry,
  type ErrorNavigator,
} from "./query-client";
import { ServerFnError } from "./server/middleware/server-fn-error";

function fakeRouter(href = "/merge?pr=7", pathname = "/merge") {
  const navigate = vi.fn(async (_opts: unknown) => undefined);
  const router: ErrorNavigator = {
    navigate,
    resolveRedirect: (r) => {
      r.options.href ??= "/resolved";
      return r;
    },
    state: { location: { href, pathname } },
  };
  return { router, navigate };
}

const unauthenticated = () =>
  new FnRequestError({
    kind: "unauthenticated",
    message: "Authentication is required.",
    requestId: "r-1",
  });

const internal = () =>
  new ServerFnError({
    kind: "internal",
    message: "Internal server error.",
    requestId: "r-2",
    status: 500,
  });

/** What the browser deserializes a thrown `ServerFnError` into (message only). */
const overTheWire = (e: ServerFnError) => new Error(e.message);

describe("global error handler", () => {
  it("navigates to a redirect thrown by a background query or mutation", () => {
    const { router, navigate } = fakeRouter();
    createGlobalErrorHandler(() => router)(redirect({ href: "/login?redirect=%2Fmerge" }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]![0]).toMatchObject({ href: "/login?redirect=%2Fmerge" });
  });

  it("sends an unauthenticated caller to /login with the current page as `redirect`", () => {
    const { router, navigate } = fakeRouter("/merge?pr=7");
    createGlobalErrorHandler(() => router)(unauthenticated());
    expect(navigate).toHaveBeenCalledWith({
      href: `/login?redirect=${encodeURIComponent("/merge?pr=7")}`,
      replace: true,
    });
  });

  it("recognises a deserialized unauthenticated ServerFnError", () => {
    const { router, navigate } = fakeRouter("/settings");
    const e = new ServerFnError({
      kind: "unauthenticated",
      message: "Authentication is required.",
      requestId: "r-3",
      status: 401,
    });
    createGlobalErrorHandler(() => router)(overTheWire(e));
    expect(navigate).toHaveBeenCalledWith({
      href: `/login?redirect=${encodeURIComponent("/settings")}`,
      replace: true,
    });
  });

  it("does not navigate again while already on /login", () => {
    const { router, navigate } = fakeRouter("/login?redirect=%2F", "/login");
    createGlobalErrorHandler(() => router)(unauthenticated());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leaves any other error to the query's own error state", () => {
    const { router, navigate } = fakeRouter();
    const handle = createGlobalErrorHandler(() => router);
    handle(internal());
    handle(overTheWire(internal()));
    handle(new Error("boom"));
    handle(notFound());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("never throws, even before the router exists or when resolving the redirect fails", () => {
    expect(() => createGlobalErrorHandler(() => undefined)(unauthenticated())).not.toThrow();
    const { router } = fakeRouter();
    router.resolveRedirect = () => {
      throw new Error("Redirect blocked: unsafe protocol");
    };
    expect(() => createGlobalErrorHandler(() => router)(redirect({ href: "x" }))).not.toThrow();
  });
});

describe("retry predicate", () => {
  it("never retries a redirect or an auth error", () => {
    expect(shouldRetry(0, redirect({ href: "/login" }))).toBe(false);
    expect(shouldRetry(0, unauthenticated())).toBe(false);
  });

  it("retries other failures once", () => {
    expect(shouldRetry(0, internal())).toBe(true);
    expect(shouldRetry(1, internal())).toBe(false);
  });
});

describe("createQueryClient", () => {
  it("routes QueryCache errors to the handler and does not retry a redirect", async () => {
    const { router, navigate } = fakeRouter();
    const client = createQueryClient(() => router);
    const queryFn = vi.fn(async () => {
      throw redirect({ href: "/login" });
    });
    await expect(client.fetchQuery({ queryKey: ["x"], queryFn })).rejects.toSatisfy(
      (e) => e instanceof Response,
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("routes MutationCache errors to the handler", async () => {
    const { router, navigate } = fakeRouter("/settings");
    const client = createQueryClient(() => router);
    const mutation = client.getMutationCache().build(client, {
      mutationFn: async () => {
        throw unauthenticated();
      },
    });
    await expect(mutation.execute(undefined)).rejects.toBeInstanceOf(FnRequestError);
    expect(navigate).toHaveBeenCalledWith({
      href: `/login?redirect=${encodeURIComponent("/settings")}`,
      replace: true,
    });
  });

  it("does not dehydrate a failed query (its error may not be serializable)", async () => {
    const client = createQueryClient(() => undefined);
    await client
      .fetchQuery({
        queryKey: ["fail"],
        queryFn: async () => {
          throw redirect({ href: "/login" });
        },
      })
      .catch(() => undefined);
    const should = client.getDefaultOptions().dehydrate?.shouldDehydrateQuery;
    const query = client.getQueryCache().find({ queryKey: ["fail"] })!;
    expect(query.state.status).toBe("error");
    expect(should?.(query)).toBe(false);
  });
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("prefetchSafe", () => {
  it("re-throws a redirect so the loader propagates it", async () => {
    const r = redirect({ href: "/login" });
    await expect(
      prefetchSafe(client(), {
        queryKey: ["r"],
        queryFn: async () => {
          throw r;
        },
      }),
    ).rejects.toBe(r);
  });

  it("swallows any other failure (the component shows its own error state)", async () => {
    await expect(
      prefetchSafe(client(), {
        queryKey: ["e"],
        queryFn: async () => {
          throw internal();
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("warms the cache on success", async () => {
    const c = client();
    await prefetchSafe(c, { queryKey: ["ok"], queryFn: async () => 42 });
    expect(c.getQueryData(["ok"])).toBe(42);
  });
});
