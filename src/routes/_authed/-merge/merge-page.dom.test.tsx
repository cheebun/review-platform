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
import {
  aGates,
  aHistory,
  aHistoryItem,
  aQueue,
  aQueueItem,
  PR_URL,
  SHA,
  someGates,
} from "./fixtures";
import { MergePage } from "./merge-page";

const fns = vi.hoisted(() => ({
  fetchMergeQueue: vi.fn(),
  fetchMergeGates: vi.fn(),
  mergePrFn: vi.fn(),
  fetchMergeHistory: vi.fn(),
}));
vi.mock("../../../functions/merge", () => fns);

const ok = <T,>(value: T) => ({ ok: true, value });
const fail = (error: Record<string, unknown>) => ({
  ok: false,
  error: { message: "server text", requestId: "req-7", ...error },
});

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MergePage />
        <Toaster />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/merge"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "Merge" });
  return { user: userEvent.setup() };
}

const queueList = () => screen.findByRole("list", { name: "待合并" });

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
  fns.fetchMergeHistory.mockResolvedValue(ok(aHistory({ items: [] })));
});

describe("MergePage queue", () => {
  it("lists reviewed PRs with title, author, SHA and their live gates", async () => {
    fns.fetchMergeQueue.mockResolvedValue(ok(aQueue()));
    let resolve!: (v: unknown) => void;
    fns.fetchMergeGates.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderPage();
    const row = within(await queueList()).getAllByRole("listitem")[0]!;
    expect(row).toHaveTextContent("acme/web#7");
    expect(row).toHaveTextContent("Add login");
    expect(row).toHaveTextContent("alice");
    expect(row).toHaveTextContent("a1b2c3d");
    expect(within(row).getByRole("status", { name: "正在检查合并条件" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(fns.fetchMergeGates).toHaveBeenCalledWith({ data: { prUrl: PR_URL } });

    resolve(ok(aGates({ gates: someGates({ no_p0: "waived" }), p0Waived: true })));
    const gates = await within(row).findByRole("list", { name: "合并条件" });
    const items = within(gates).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    expect(items[0]).toHaveTextContent("仓库在列表中");
    expect(items[0]).toHaveTextContent("通过");
    expect(items[4]).toHaveTextContent("已豁免");
    expect(within(row).getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  it("a failing gate disables Merge and shows the reason; unknown is marked", async () => {
    fns.fetchMergeQueue.mockResolvedValue(ok(aQueue()));
    fns.fetchMergeGates.mockResolvedValue(
      ok(
        aGates({
          gates: someGates({ approved_at_sha: "fail", mergeable: "unknown" }),
          canMerge: false,
          blockedReason: "notApproved",
        }),
      ),
    );
    await renderPage();
    const row = within(await queueList()).getAllByRole("listitem")[0]!;
    expect(await within(row).findByText("请先 approve（或 force approve）。")).toBeInTheDocument();
    const items = within(within(row).getByRole("list", { name: "合并条件" })).getAllByRole(
      "listitem",
    );
    expect(items[3]).toHaveTextContent("未通过");
    expect(items[6]).toHaveTextContent("未知");
    expect(within(row).getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("renders untrusted PR title and check names as plain text", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    fns.fetchMergeQueue.mockResolvedValue(ok(aQueue({ items: [aQueueItem({ title: evil })] })));
    fns.fetchMergeGates.mockResolvedValue(
      ok(
        aGates({
          gates: someGates({ checks_green: "fail" }),
          canMerge: false,
          blockedReason: "checksNotGreen",
          checks: { state: "failing", failing: ["<b>lint</b>"], pending: [] },
        }),
      ),
    );
    await renderPage();
    const row = within(await queueList()).getAllByRole("listitem")[0]!;
    expect(row).toHaveTextContent(evil);
    expect(await within(row).findByText(/<b>lint<\/b>/)).toBeInTheDocument();
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("b")).toBeNull();
  });

  it("empty queue says so", async () => {
    fns.fetchMergeQueue.mockResolvedValue(ok(aQueue({ items: [] })));
    await renderPage();
    expect(await screen.findByText("Nothing awaiting merge")).toBeInTheDocument();
  });

  it.each([
    ["not_configured", "GitHub 未配置"],
    ["needs_reset", "GitHub 凭据需要重新设置"],
    ["no_repos", "还没有配置仓库"],
  ] as const)("github %s shows an alert linking to settings", async (github, title) => {
    fns.fetchMergeQueue.mockResolvedValue(ok(aQueue({ github, items: [] })));
    await renderPage();
    const alert = await screen.findByText(title);
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往设置" })).toHaveAttribute("href", "/settings");
    expect(fns.fetchMergeGates).not.toHaveBeenCalled();
  });

  it("queue failure shows the fixed text and request id, never the server message", async () => {
    fns.fetchMergeQueue.mockResolvedValue(fail({ kind: "internal" }));
    await renderPage();
    const alert = await screen.findByText(/无法读取待合并列表/);
    expect(alert).toHaveTextContent("req-7");
    expect(screen.queryByText(/server text/)).toBeNull();
  });
});

async function openDialog() {
  fns.fetchMergeQueue.mockResolvedValue(ok(aQueue()));
  fns.fetchMergeGates.mockResolvedValue(ok(aGates()));
  const { user } = await renderPage();
  const row = within(await queueList()).getAllByRole("listitem")[0]!;
  const button = within(row).getByRole("button", { name: "Merge" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  const dialog = await screen.findByRole("dialog");
  return { user, dialog, row };
}
describe("MergePage merge", () => {
  it("confirms with the full head SHA, merges via web and toasts", async () => {
    const { user, dialog } = await openDialog();
    expect(dialog).toHaveTextContent(SHA);
    expect(dialog).toHaveTextContent("acme/web#7");
    fns.mergePrFn.mockResolvedValue(
      ok({ status: "merged", sha: SHA, mergeSha: "f".repeat(40), p0Waived: false }),
    );
    const queueCalls = fns.fetchMergeQueue.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "确认合并" }));
    expect(fns.mergePrFn).toHaveBeenCalledWith({ data: { prUrl: PR_URL, expectedSha: SHA } });
    expect(await screen.findByText("已合并 acme/web#7")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fns.fetchMergeQueue.mock.calls.length).toBeGreaterThan(queueCalls));
  });

  it("a refusal shows the reason and the returned gates", async () => {
    const { user, dialog, row } = await openDialog();
    fns.mergePrFn.mockResolvedValue(
      ok({
        status: "refused",
        reason: "checksNotGreen",
        headMoved: false,
        gates: someGates({ checks_green: "fail" }),
        requestId: "req-9",
      }),
    );
    fns.fetchMergeGates.mockResolvedValue(
      ok(
        aGates({
          gates: someGates({ checks_green: "fail" }),
          canMerge: false,
          blockedReason: "checksNotGreen",
        }),
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "确认合并" }));
    const alert = await within(row).findByRole("alert");
    expect(alert).toHaveTextContent("CI 检查未全部通过。");
    expect(alert).toHaveTextContent("req-9");
    const refused = within(alert).getByRole("list", { name: "拒绝时的合并条件" });
    expect(within(refused).getAllByRole("listitem")[5]).toHaveTextContent("未通过");
  });

  it("head moved refetches the gates", async () => {
    const { user, dialog, row } = await openDialog();
    fns.mergePrFn.mockResolvedValue(
      ok({
        status: "refused",
        reason: "headMoved",
        headMoved: true,
        gates: someGates({}),
        requestId: "r",
      }),
    );
    const before = fns.fetchMergeGates.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "确认合并" }));
    expect(
      await within(row).findByText("PR 有新提交，已刷新检查项，请重新确认。"),
    ).toBeInTheDocument();
    await waitFor(() => expect(fns.fetchMergeGates.mock.calls.length).toBeGreaterThan(before));
  });

  it("a failed call shows the fixed error text with the request id", async () => {
    const { user, dialog } = await openDialog();
    fns.mergePrFn.mockResolvedValue(fail({ kind: "rate_limited" }));
    await user.click(within(dialog).getByRole("button", { name: "确认合并" }));
    expect(await screen.findByText(/操作太频繁/)).toBeInTheDocument();
    expect(screen.queryByText(/server text/)).toBeNull();
  });
});

describe("MergePage history", () => {
  it("shows merged events with who, source, SHA and time", async () => {
    fns.fetchMergeQueue.mockResolvedValue(ok(aQueue({ items: [] })));
    fns.fetchMergeHistory.mockResolvedValue(
      ok(
        aHistory({
          items: [
            aHistoryItem(),
            aHistoryItem({
              id: "evt-2",
              number: 6,
              prUrl: "https://github.com/acme/web/pull/6",
              actor: { kind: "user", id: "user-2", self: false },
              source: "slack",
            }),
          ],
        }),
      ),
    );
    await renderPage();
    const table = await screen.findByRole("table", { name: "合并记录" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("acme/web#5");
    expect(rows[0]).toHaveTextContent("你");
    expect(rows[0]).toHaveTextContent("Web");
    expect(rows[0]).toHaveTextContent("a1b2c3d");
    expect(rows[0]).toHaveTextContent("2026-11-04 11:00");
    expect(rows[1]).toHaveTextContent("用户 user-2");
    expect(rows[1]).toHaveTextContent("Slack");
    expect(fns.fetchMergeHistory).toHaveBeenCalledWith({ data: { limit: 20 } });
  });

  it("empty history says so", async () => {
    fns.fetchMergeQueue.mockResolvedValue(ok(aQueue({ items: [] })));
    await renderPage();
    expect(await screen.findByText("No merges yet")).toBeInTheDocument();
  });

  it("load more asks for a larger window", async () => {
    fns.fetchMergeQueue.mockResolvedValue(ok(aQueue({ items: [] })));
    fns.fetchMergeHistory.mockResolvedValue(ok(aHistory({ hasMore: true })));
    const { user } = await renderPage();
    await user.click(await screen.findByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(fns.fetchMergeHistory).toHaveBeenCalledWith({ data: { limit: 40 } }),
    );
  });
});
