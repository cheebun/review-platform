import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route as CatchAllRoute } from "./$";
import type { RouterContext } from "./__root";
import { Route as AuthedRoute } from "./_authed";
import { Route as LoginRoute } from "./login";
import { Route as SetupRoute } from "./setup";

// The functions/ boundary is the one module mock the component project allows (testing.md §3.1).
const fns = vi.hoisted(() => ({
  getSetupStatus: vi.fn<() => Promise<{ initialized: boolean }>>(),
  loginWithToken: vi.fn(),
  rotateLoginToken: vi.fn(),
  getViewer: vi.fn<() => Promise<{ email: string } | null>>(),
}));
const setup = vi.hoisted(() => ({
  finishSetup: vi.fn(),
  getSetupSections: vi.fn(async () => ({
    ok: true,
    value: { anthropic: false, github: false, slack: false },
  })),
  testSetupAnthropic: vi.fn(),
  listSetupGithubRepos: vi.fn(),
  testSetupSlack: vi.fn(),
}));
vi.mock("../functions/login-token", () => fns);
vi.mock("../functions/viewer", () => ({ getViewer: fns.getViewer }));
vi.mock("../functions/setup", () => setup);

/** The internal account email of the single owner; never shown in the UI. */
const OWNER_EMAIL = "owner@agent-ops.invalid";

function renderApp(initial: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: () => <Outlet /> });
  const authed = AuthedRoute.update({
    id: "_authed",
    getParentRoute: () => rootRoute,
  } as never) as unknown as AnyRoute;
  const home = createRoute({
    getParentRoute: () => authed,
    path: "/",
    component: () => <p>HOME PAGE</p>,
  });
  const routeTree = rootRoute.addChildren([
    authed.addChildren([home]),
    LoginRoute.update({ id: "/login", path: "/login", getParentRoute: () => rootRoute } as never),
    SetupRoute.update({ id: "/setup", path: "/setup", getParentRoute: () => rootRoute } as never),
    CatchAllRoute.update({ id: "/$", path: "$", getParentRoute: () => rootRoute } as never),
  ]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const at = async (router: ReturnType<typeof renderApp>, href: string) =>
  waitFor(() => expect(router.state.location.href).toBe(href));

function state(initialized: boolean, signedIn: boolean) {
  fns.getSetupStatus.mockResolvedValue({ initialized });
  if (signedIn) fns.getViewer.mockResolvedValue({ email: OWNER_EMAIL });
  // From the browser an anonymous getViewer RPC is a 401, which rejects.
  else fns.getViewer.mockRejectedValue(new Error("401"));
}

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
});

/** Every /setup URL: the wizard keeps no state in the URL, so a query never matters. */
const SETUP_URLS = ["/setup", "/setup?step=2", "/setup?step=4", "/setup?x=1"];

describe("page guards before initialization (FR-AUTH-01)", () => {
  it.each(["/", "/login", "/login?redirect=%2Fmerge", "/no-such-page", "/setup?step=3"])(
    "%s → /setup",
    async (path) => {
      state(false, false);
      const router = renderApp(path);
      await at(router, "/setup");
      expect(await screen.findByLabelText("登录令牌")).toBeInTheDocument();
    },
  );

  it("/setup renders step 1, without a redirect loop", async () => {
    state(false, false);
    const router = renderApp("/setup");
    expect(await screen.findByLabelText("再次输入登录令牌")).toBeInTheDocument();
    expect(router.state.location.href).toBe("/setup");
  });

  it("an existing session cookie does not get past setup", async () => {
    state(false, true);
    const router = renderApp("/");
    await at(router, "/setup");
  });
});

describe("page guards after initialization, anonymous", () => {
  it.each(SETUP_URLS)("%s → /login (AC 3)", async (path) => {
    state(true, false);
    const router = renderApp(path);
    await at(router, "/login");
    expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("/ → /login?redirect=%2F (FR-AUTH-03 AC 1)", async () => {
    state(true, false);
    const router = renderApp("/");
    await at(router, "/login?redirect=%2F");
  });

  it("an unknown page → /login first", async () => {
    state(true, false);
    const router = renderApp("/no-such-page");
    await at(router, "/login?redirect=%2Fno-such-page");
  });

  it("/login shows the form", async () => {
    state(true, false);
    renderApp("/login");
    expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
  });
});

describe("page guards after initialization, signed in", () => {
  it.each(SETUP_URLS)("%s → / (AC 3)", async (path) => {
    state(true, true);
    const router = renderApp(path);
    await at(router, "/");
    expect(await screen.findByText("HOME PAGE")).toBeInTheDocument();
  });

  it("/ renders inside the shell, which never shows the internal account email", async () => {
    state(true, true);
    renderApp("/");
    expect(await screen.findByText("HOME PAGE")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
    expect(screen.queryByText(OWNER_EMAIL)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(OWNER_EMAIL);
  });
});
