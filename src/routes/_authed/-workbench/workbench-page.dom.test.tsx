import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../../../ui";
import { aMergeSummary, aReviewSummary, aSetupStatus } from "./fixtures";
import { WorkbenchPage } from "./workbench-page";

const fns = vi.hoisted(() => ({
  fetchReviewSummary: vi.fn(),
  fetchMergeSummary: vi.fn(),
  fetchSetupStatus: vi.fn(),
}));
vi.mock("../../../functions/workbench", () => fns);

const ok = <T,>(value: T) => ({ ok: true, value });
const fail = (error: Record<string, unknown> = {}) => ({
  ok: false,
  error: { kind: "internal", message: "server text", requestId: "req-7", ...error },
});
const never = () => new Promise(() => {});

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <WorkbenchPage />
        <Toaster />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "Overview" });
  return { user: userEvent.setup() };
}

const card = (name: string) => screen.findByRole("region", { name });
const hrefOf = (el: HTMLElement) => el.getAttribute("href");

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
  fns.fetchReviewSummary.mockResolvedValue(ok(aReviewSummary()));
  fns.fetchMergeSummary.mockResolvedValue(ok(aMergeSummary()));
  fns.fetchSetupStatus.mockResolvedValue(ok(aSetupStatus()));
});

describe("WorkbenchPage loading", () => {
  it("each card shows its own skeleton while loading", async () => {
    fns.fetchReviewSummary.mockReturnValue(never());
    fns.fetchMergeSummary.mockReturnValue(never());
    fns.fetchSetupStatus.mockReturnValue(never());
    await renderPage();
    for (const label of ["正在加载评审概况", "正在加载待合并", "正在加载设置状态"]) {
      expect(await screen.findByRole("status", { name: label })).toBeInTheDocument();
    }
  });
});

describe("WorkbenchPage review card", () => {
  it("shows the 7-day counts by outcome, each linking to the filtered /review", async () => {
    await renderPage();
    const region = await card("评审");
    const counts = await within(region).findByRole("list", { name: "最近 7 天评审结果" });
    const links = within(counts).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["🟢 通过4", "🔴 需修改2", "失败1"]);
    expect(hrefOf(links[0]!)).toBe("/review?outcome=pass&from=2026-10-30&to=2026-11-05");
    expect(hrefOf(links[2]!)).toBe("/review?outcome=failed&from=2026-10-30&to=2026-11-05");
    expect(region).toHaveTextContent("10-30 至 11-05（UTC+8）");
    expect(hrefOf(within(region).getByRole("link", { name: "查看全部评审" }))).toBe("/review");
  });

  it("marks truncated counts as lower bounds", async () => {
    fns.fetchReviewSummary.mockResolvedValue(
      ok(
        aReviewSummary({ truncated: true, counts: { pass: 990, changes_requested: 9, failed: 1 } }),
      ),
    );
    await renderPage();
    const counts = await within(await card("评审")).findByRole("list", {
      name: "最近 7 天评审结果",
    });
    expect(counts).toHaveTextContent("990+");
  });

  it("lists the latest reviews, each linking to its detail page", async () => {
    await renderPage();
    const list = await within(await card("评审")).findByRole("list", { name: "最近评审" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const link = within(rows[0]!).getByRole("link", { name: "acme/web#7" });
    expect(hrefOf(link)).toBe("/review/rev-1");
    expect(rows[0]).toHaveTextContent("🟢 通过");
    expect(rows[0]).toHaveTextContent("2026-11-05 10:00");
    expect(rows[1]).toHaveTextContent("🔴 需修改");
    expect(rows[2]).toHaveTextContent("失败");
  });

  it("with no reviews, says so", async () => {
    fns.fetchReviewSummary.mockResolvedValue(
      ok(aReviewSummary({ counts: { pass: 0, changes_requested: 0, failed: 0 }, latest: [] })),
    );
    await renderPage();
    expect(await within(await card("评审")).findByText("还没有评审记录。")).toBeInTheDocument();
  });

  it("an error stays in its card, with a retry; the other cards still load", async () => {
    fns.fetchReviewSummary.mockResolvedValueOnce(fail());
    const { user } = await renderPage();
    const region = await card("评审");
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent("req-7");
    expect(alert).not.toHaveTextContent("server text");
    expect(await within(await card("待合并")).findByText("3")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fns.fetchReviewSummary).toHaveBeenCalledTimes(2));
    expect(
      await within(region).findByRole("list", { name: "最近 7 天评审结果" }),
    ).toBeInTheDocument();
  });
});

describe("WorkbenchPage merge card", () => {
  it("shows how many PRs await merge and how many passed review, linking to /merge", async () => {
    await renderPage();
    const region = await card("待合并");
    expect(await within(region).findByText("3")).toBeInTheDocument();
    expect(region).toHaveTextContent("个 PR 待合并");
    expect(region).toHaveTextContent("其中 2 个评审通过");
    expect(hrefOf(within(region).getByRole("link", { name: "去合并" }))).toBe("/merge");
  });

  it("a capped count shows a plus", async () => {
    fns.fetchMergeSummary.mockResolvedValue(ok(aMergeSummary({ awaiting: 50, capped: true })));
    await renderPage();
    expect(await within(await card("待合并")).findByText("50+")).toBeInTheDocument();
  });

  it("with nothing to merge, says so", async () => {
    fns.fetchMergeSummary.mockResolvedValue(ok(aMergeSummary({ awaiting: 0, passing: 0 })));
    await renderPage();
    expect(await within(await card("待合并")).findByText("没有待合并的 PR。")).toBeInTheDocument();
  });

  it.each([
    ["not_configured", "GitHub 未配置"],
    ["needs_reset", "需要重新设置"],
    ["no_repos", "还没有配置仓库"],
  ] as const)("github %s: shows the notice with a link to /settings", async (github, text) => {
    fns.fetchMergeSummary.mockResolvedValue(ok(aMergeSummary({ github, awaiting: 0 })));
    await renderPage();
    const region = await card("待合并");
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(hrefOf(within(alert).getByRole("link", { name: "去设置" }))).toBe("/settings");
  });

  it("an error shows the fixed text and request id", async () => {
    fns.fetchMergeSummary.mockResolvedValue(fail({ kind: "upstream" }));
    await renderPage();
    const alert = await within(await card("待合并")).findByRole("alert");
    expect(alert).toHaveTextContent("req-7");
    expect(alert).not.toHaveTextContent("server text");
  });
});

describe("WorkbenchPage cards", () => {
  it("shows exactly the review, merge and setup cards", async () => {
    await renderPage();
    for (const name of ["评审", "待合并", "设置状态"]) await card(name);
    const cards = screen.getAllByRole("region").filter((r) => r.hasAttribute("aria-labelledby"));
    expect(cards).toHaveLength(3);
    expect(screen.queryByText(/日报/)).toBeNull();
  });
});

describe("WorkbenchPage setup card", () => {
  it("shows each section's state, linking to /settings only where action is needed", async () => {
    fns.fetchSetupStatus.mockResolvedValue(
      ok(aSetupStatus({ slack: "not_configured", llm: "needs_reset" })),
    );
    await renderPage();
    const list = await within(await card("设置状态")).findByRole("list", { name: "配置项" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent?.replace("去设置", ""))).toEqual([
      "GitHub已配置",
      "Slack未配置",
      "LLM需要重新设置",
    ]);
    expect(within(rows[0]!).queryByRole("link")).toBeNull();
    expect(hrefOf(within(rows[1]!).getByRole("link", { name: "去设置 Slack" }))).toBe("/settings");
    expect(hrefOf(within(rows[2]!).getByRole("link", { name: "去设置 LLM" }))).toBe("/settings");
  });

  it("an error stays in its card", async () => {
    fns.fetchSetupStatus.mockResolvedValue(fail());
    await renderPage();
    const alert = await within(await card("设置状态")).findByRole("alert");
    expect(alert).toHaveTextContent("req-7");
  });
});
