import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route as LoginRoute } from "./login";

// The functions/ boundary is the one module mock the component project allows (testing.md §3.1).
const fns = vi.hoisted(() => ({
  getSetupStatus: vi.fn<() => Promise<{ initialized: boolean }>>(),
  loginWithToken: vi.fn<(opts: { data: { token: string } }) => Promise<unknown>>(),
}));
vi.mock("../functions/login-token", () => fns);

function renderLogin(initial = "/login") {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const page = (path: string, text: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => <p>{text}</p> });
  const routeTree = rootRoute.addChildren([
    LoginRoute.update({ id: "/login", path: "/login", getParentRoute: () => rootRoute } as never),
    page("/setup", "SETUP PAGE"),
    page("/", "HOME PAGE"),
    page("/review", "REVIEW PAGE"),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

// Covers login.tsx (route loader + component); lives beside the form it renders.
describe("/login route", () => {
  beforeEach(() => {
    fns.getSetupStatus.mockReset();
    fns.loginWithToken.mockReset();
  });

  it("redirects to /setup before initialization", async () => {
    fns.getSetupStatus.mockResolvedValue({ initialized: false });
    const router = renderLogin();
    expect(await screen.findByText("SETUP PAGE")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("shows the token form once initialized", async () => {
    fns.getSetupStatus.mockResolvedValue({ initialized: true });
    renderLogin();
    expect(await screen.findByLabelText("登录令牌")).toBeInTheDocument();
  });

  it("sends the token through the server function and goes to the safe redirect", async () => {
    fns.getSetupStatus.mockResolvedValue({ initialized: true });
    fns.loginWithToken.mockResolvedValue({ ok: true, value: null });
    const router = renderLogin(`/login?redirect=${encodeURIComponent("/review?x=1")}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("登录令牌"), "secret-token");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("REVIEW PAGE")).toBeInTheDocument();
    expect(fns.loginWithToken).toHaveBeenCalledWith({ data: { token: "secret-token" } });
    expect(router.state.location.href).toBe("/review?x=1");
  });

  it("falls back to / for an unsafe redirect", async () => {
    fns.getSetupStatus.mockResolvedValue({ initialized: true });
    fns.loginWithToken.mockResolvedValue({ ok: true, value: null });
    renderLogin(`/login?redirect=${encodeURIComponent("//evil.example")}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("登录令牌"), "secret-token");
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("HOME PAGE")).toBeInTheDocument();
  });

  it("goes to /setup when login says not initialized", async () => {
    fns.getSetupStatus.mockResolvedValue({ initialized: true });
    fns.loginWithToken.mockResolvedValue({
      ok: false,
      error: { kind: "not_found", message: "x", requestId: "r" },
    });
    const router = renderLogin();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("登录令牌"), "secret-token");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
  });
});
