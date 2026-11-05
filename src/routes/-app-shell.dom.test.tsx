import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./-app-shell";
import { navLinks } from "./-nav";

async function renderShell(path: string, signOut = vi.fn(async () => {})) {
  const afterSignOut = vi.fn();
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell signOut={signOut} afterSignOut={afterSignOut}>
        <p>page body</p>
      </AppShell>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByText("page body");
  return { signOut, afterSignOut, user: userEvent.setup() };
}

const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("AppShell", () => {
  it("renders every nav link in order: Overview, Review, Merge, Settings", async () => {
    await renderShell("/merge");
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Overview", "Review", "Merge", "Settings"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(navLinks().map((i) => i.to));
  });

  it("the main list is flat: Overview, Review and Merge are siblings, with no group header", async () => {
    await renderShell("/");
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByRole("group")).not.toBeInTheDocument();
    expect(within(nav).queryByText(/github/i)).not.toBeInTheDocument();
    const [main] = within(nav).getAllByRole("list");
    const items = within(main).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Overview", "Review", "Merge"]);
    for (const li of items) expect(li.parentElement).toBe(main);
  });

  it("Settings and sign-out sit at the bottom, after the main links", async () => {
    await renderShell("/");
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const merge = within(nav).getByRole("link", { name: "Merge" });
    const settings = within(nav).getByRole("link", { name: "Settings" });
    const signOut = screen.getByRole("button", { name: "退出登录" });
    expect(before(merge, settings)).toBe(true);
    expect(before(settings, signOut)).toBe(true);
  });

  it.each([
    ["/review/r-1", "Review"],
    ["/merge", "Merge"],
    ["/settings", "Settings"],
    ["/", "Overview"],
  ])("on %s marks %s as current, and only it", async (path, label) => {
    await renderShell(path);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const current = within(nav)
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current") === "page")
      .map((a) => a.textContent);
    expect(current).toEqual([label]);
  });

  it("is keyboard accessible: Tab visits every link then sign-out", async () => {
    const { user } = await renderShell("/");
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await user.tab();
      order.push(document.activeElement?.textContent ?? "");
    }
    expect(order).toEqual([
      "Review platform",
      "Overview",
      "Review",
      "Merge",
      "Settings",
      "退出登录",
    ]);
  });

  it("has no Daily UI tweaks link and no link that leaves the app", async () => {
    await renderShell("/");
    expect(screen.queryByRole("link", { name: "Daily UI tweaks" })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("target", "_blank");
      expect(link.getAttribute("href")).toMatch(/^\//);
    }
  });

  it("shows no account email: the single owner's internal address is not for display", async () => {
    await renderShell("/");
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it("signs out", async () => {
    const { signOut, afterSignOut, user } = await renderShell("/");
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(afterSignOut).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("a failed sign-out still leaves the app (fail closed)", async () => {
    const { afterSignOut, user } = await renderShell(
      "/",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(afterSignOut).toHaveBeenCalledTimes(1));
  });
});
