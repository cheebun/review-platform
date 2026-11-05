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
import { aListItem, aListView } from "./fixtures";
import { ReviewListPage } from "./review-list-page";
import type { ReviewSearch } from "./search";

const fns = vi.hoisted(() => ({ fetchReviewList: vi.fn(), fetchReviewDetail: vi.fn() }));
vi.mock("../../../functions/review", () => fns);

const ok = <T,>(value: T) => ({ ok: true, value });
const fail = (error: Record<string, unknown>) => ({
  ok: false,
  error: { message: "x", requestId: "req-7", ...error },
});

async function renderPage(search: ReviewSearch = {}) {
  const onSearchChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => <ReviewListPage search={search} onSearchChange={onSearchChange} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/review"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "Review" });
  return { onSearchChange, user: userEvent.setup() };
}

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
});

describe("ReviewListPage", () => {
  it("loading, then one row per record with PR, marker, SHA, requester, time and approval", async () => {
    let resolve!: (v: unknown) => void;
    fns.fetchReviewList.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderPage();
    expect(screen.getByRole("status", { name: "正在加载评审记录" })).toBeInTheDocument();
    resolve(
      ok(
        aListView({
          items: [
            aListItem(),
            aListItem({
              id: "rev-2",
              number: 8,
              verdict: "changes_requested",
              marker: "changes_requested",
              approval: { kind: "skipped", at: "x", reason: "own_pr" },
              requester: { kind: "user", id: "u1", self: true },
              source: "web",
              findingCounts: [{ severity: "P0", count: 2 }],
            }),
            aListItem({
              id: "rev-3",
              number: 9,
              status: "failed",
              verdict: null,
              marker: null,
              approval: null,
            }),
          ],
        }),
      ),
    );
    const list = await screen.findByRole("list", { name: "评审记录" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    const first = rows[0]!;
    expect(within(first).getByRole("link", { name: "acme/web#7" })).toHaveAttribute(
      "href",
      "/review/rev-1",
    );
    expect(first).toHaveTextContent("🟢 通过");
    expect(first).toHaveTextContent("a1b2c3d");
    expect(first).toHaveTextContent("Slack U123");
    expect(first).toHaveTextContent("2026-11-04 10:00");
    expect(first).toHaveTextContent("已批准（auto: review passed）");
    expect(first).toHaveTextContent("slack");

    expect(rows[1]).toHaveTextContent("🔴 需修改");
    expect(rows[1]).toHaveTextContent("已跳过：自己的 PR");
    expect(rows[1]).toHaveTextContent("你");
    expect(rows[1]).toHaveTextContent("P0 × 2");

    expect(rows[2]).toHaveTextContent("失败");
    expect(rows[2]).not.toHaveTextContent(/🟢|🔴|🟡/);
  });

  it("is view-only: no review action buttons", async () => {
    fns.fetchReviewList.mockResolvedValue(ok(aListView()));
    await renderPage();
    await screen.findByRole("list", { name: "评审记录" });
    const names = screen.queryAllByRole("button").map((b) => b.textContent ?? "");
    expect(names.filter((n) => /review|ship|approve|批准|评审|合并|merge/i.test(n))).toEqual([]);
  });

  it("shows merged and force approval markers", async () => {
    fns.fetchReviewList.mockResolvedValue(
      ok(
        aListView({
          items: [
            aListItem({
              marker: "force_approved",
              merged: true,
              approval: { kind: "force_approved", at: "x" },
            }),
          ],
        }),
      ),
    );
    await renderPage();
    const row = await screen.findByRole("listitem");
    expect(row).toHaveTextContent("🟡 强制批准");
    expect(row).toHaveTextContent("✅ 已合并");
  });

  it("renders untrusted text as text, never as HTML", async () => {
    fns.fetchReviewList.mockResolvedValue(
      ok(
        aListView({
          items: [
            aListItem({
              requester: { kind: "slack", id: "<img src=x onerror=alert(1)>", self: false },
            }),
          ],
        }),
      ),
    );
    await renderPage();
    const row = await screen.findByRole("listitem");
    expect(row).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(row.querySelector("img")).toBeNull();
  });

  it("empty history", async () => {
    fns.fetchReviewList.mockResolvedValue(ok(aListView({ items: [] })));
    await renderPage();
    expect(await screen.findByText("还没有评审记录。")).toBeInTheDocument();
  });

  it("empty with filters: says so and offers to clear them", async () => {
    fns.fetchReviewList.mockResolvedValue(ok(aListView({ items: [] })));
    const { onSearchChange, user } = await renderPage({ outcome: "failed" });
    expect(await screen.findByText("没有符合筛选条件的评审。")).toBeInTheDocument();
    const clears = screen.getAllByRole("button", { name: "清除筛选" });
    await user.click(clears[0]!);
    expect(onSearchChange).toHaveBeenCalledWith({});
  });

  it("passes the filters to the server function", async () => {
    fns.fetchReviewList.mockResolvedValue(ok(aListView()));
    await renderPage({ repo: "acme/web", outcome: "pass", source: "web", from: "2026-11-01" });
    await screen.findByRole("list", { name: "评审记录" });
    expect(fns.fetchReviewList).toHaveBeenCalledWith({
      data: { repo: "acme/web", outcome: "pass", source: "web", from: "2026-11-01" },
    });
  });

  it("changing a date filter updates the search", async () => {
    fns.fetchReviewList.mockResolvedValue(ok(aListView()));
    const { onSearchChange, user } = await renderPage({ source: "slack" });
    await screen.findByRole("list", { name: "评审记录" });
    const from = screen.getByLabelText("开始日期");
    await user.clear(from);
    await user.type(from, "2026-11-02");
    await waitFor(() =>
      expect(onSearchChange).toHaveBeenLastCalledWith({ source: "slack", from: "2026-11-02" }),
    );
  });

  it("choosing a repo updates the search", async () => {
    fns.fetchReviewList.mockResolvedValue(ok(aListView()));
    const { onSearchChange, user } = await renderPage();
    await screen.findByRole("list", { name: "评审记录" });
    await user.click(screen.getByRole("combobox", { name: "仓库" }));
    await user.click(await screen.findByRole("option", { name: "acme/api" }));
    await waitFor(() => expect(onSearchChange).toHaveBeenLastCalledWith({ repo: "acme/api" }));
  });

  it("loads the next page with the cursor", async () => {
    fns.fetchReviewList
      .mockResolvedValueOnce(ok(aListView({ nextCursor: "c1" })))
      .mockResolvedValueOnce(
        ok(aListView({ items: [aListItem({ id: "rev-9", number: 99 })], nextCursor: null })),
      );
    const { user } = await renderPage();
    await screen.findByRole("list", { name: "评审记录" });
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByRole("link", { name: "acme/web#99" })).toBeInTheDocument();
    expect(fns.fetchReviewList).toHaveBeenLastCalledWith({ data: { cursor: "c1" } });
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("error: generic text with the request id and a retry", async () => {
    fns.fetchReviewList.mockResolvedValueOnce(
      fail({ kind: "internal", message: "Internal server error." }),
    );
    const { user } = await renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("评审记录加载失败");
    expect(alert).toHaveTextContent("req-7");
    expect(alert).not.toHaveTextContent("Internal server error.");
    fns.fetchReviewList.mockResolvedValueOnce(ok(aListView()));
    await user.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "acme/web#7" })).toBeInTheDocument();
  });

  it("a validation error explains the filters", async () => {
    fns.fetchReviewList.mockResolvedValue(fail({ kind: "validation" }));
    await renderPage({ from: "2026-11-05", to: "2026-11-01" });
    expect(await screen.findByRole("alert")).toHaveTextContent("筛选条件无效");
  });
});
