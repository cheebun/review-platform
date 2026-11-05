import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aDetailView, SHA } from "./fixtures";
import { ReviewDetailPage } from "./review-detail-page";

const fns = vi.hoisted(() => ({ fetchReviewList: vi.fn(), fetchReviewDetail: vi.fn() }));
vi.mock("../../../functions/review", () => fns);

const ok = <T,>(value: T) => ({ ok: true, value });
const fail = (error: Record<string, unknown>) => ({
  ok: false,
  error: { message: "x", requestId: "req-7", ...error },
});

async function renderPage(reviewId = "rev-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <ReviewDetailPage reviewId={reviewId} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/review/${reviewId}`] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
});

const groups = [
  {
    severity: "P0",
    findings: [
      {
        severity: "P0",
        title: "<b>SQL injection</b>",
        body: "<script>alert(1)</script>",
        path: "src/db.ts",
        line: 12,
        href: `https://github.com/acme/web/blob/${SHA}/src/db.ts#L12`,
      },
    ],
  },
  { severity: "Nit", findings: [{ severity: "Nit", title: "naming", body: "rename x" }] },
];

describe("ReviewDetailPage", () => {
  it("loading, then the PR, SHA, verdict, summary and GitHub link", async () => {
    let resolve!: (v: unknown) => void;
    fns.fetchReviewDetail.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderPage();
    expect(await screen.findByRole("status", { name: "正在加载评审详情" })).toBeInTheDocument();
    resolve(ok(aDetailView()));
    expect(
      await screen.findByRole("heading", { level: 1, name: "acme/web#7" }),
    ).toBeInTheDocument();
    expect(fns.fetchReviewDetail).toHaveBeenCalledWith({ data: { id: "rev-1" } });
    expect(screen.getByText(SHA)).toBeInTheDocument();
    expect(screen.getByText("🟢 通过")).toBeInTheDocument();
    expect(screen.getByText("Looks fine.")).toBeInTheDocument();
    const gh = screen.getByRole("link", { name: "在 GitHub 打开" });
    expect(gh).toHaveAttribute("href", "https://github.com/acme/web/pull/7");
    expect(gh).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "返回评审记录" })).toHaveAttribute("href", "/review");
  });

  it("is read-only: no buttons and no forms", async () => {
    fns.fetchReviewDetail.mockResolvedValue(ok(aDetailView({ findingGroups: groups })));
    await renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
  });

  it("findings grouped by severity, with file:line links, as plain text", async () => {
    fns.fetchReviewDetail.mockResolvedValue(
      ok(
        aDetailView({
          review: { verdict: "changes_requested", marker: "changes_requested" },
          findingGroups: groups,
        }),
      ),
    );
    await renderPage();
    const p0 = await screen.findByRole("region", { name: "P0 阻塞 · 1" });
    expect(within(p0).getByText("<b>SQL injection</b>")).toBeInTheDocument();
    expect(within(p0).getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(p0.querySelector("b, script")).toBeNull();
    expect(within(p0).getByRole("link", { name: "src/db.ts:12" })).toHaveAttribute(
      "href",
      `https://github.com/acme/web/blob/${SHA}/src/db.ts#L12`,
    );
    expect(screen.getByRole("region", { name: "Nit 微调 · 1" })).toHaveTextContent("rename x");
    expect(screen.getByText(/force approve/)).toBeInTheDocument();
  });

  it("no findings", async () => {
    fns.fetchReviewDetail.mockResolvedValue(ok(aDetailView()));
    await renderPage();
    expect(await screen.findByText("没有发现问题。")).toBeInTheDocument();
  });

  it("approval: skipped shows the reason and the Slack hint", async () => {
    fns.fetchReviewDetail.mockResolvedValue(
      ok(
        aDetailView({
          review: {
            approval: {
              kind: "skipped",
              at: "2026-11-04T02:01:00.000Z",
              reason: "sha_changed",
              sha: SHA,
            },
          },
        }),
      ),
    );
    await renderPage();
    const section = await screen.findByRole("region", { name: "批准" });
    expect(section).toHaveTextContent("已跳过：PR 有新提交");
    expect(section).toHaveTextContent("approve");
  });

  it("force approval and merged badges", async () => {
    fns.fetchReviewDetail.mockResolvedValue(
      ok(
        aDetailView({
          review: {
            verdict: "changes_requested",
            marker: "force_approved",
            merged: true,
            approval: { kind: "force_approved", at: "2026-11-04T02:01:00.000Z", sha: SHA },
          },
        }),
      ),
    );
    await renderPage();
    const section = await screen.findByRole("region", { name: "批准" });
    expect(section).toHaveTextContent("🟡 强制批准");
    expect(section).toHaveTextContent("a1b2c3d");
    expect(screen.getAllByText("✅ 已合并").length).toBeGreaterThan(0);
  });

  it("the timeline, oldest first, with actor and time", async () => {
    fns.fetchReviewDetail.mockResolvedValue(
      ok(
        aDetailView({
          timeline: [
            {
              id: "e1",
              type: "review_finished",
              actor: { kind: "system", id: "owner" },
              at: "2026-11-04T02:00:00.000Z",
            },
            {
              id: "e2",
              type: "approved",
              actor: { kind: "system", id: "owner" },
              at: "2026-11-04T02:01:00.000Z",
              sha: SHA,
              source: "system",
            },
            {
              id: "e3",
              type: "merged",
              actor: { kind: "user", id: "u1" },
              at: "2026-11-04T02:05:00.000Z",
              sha: SHA,
              source: "web",
            },
          ],
        }),
      ),
    );
    await renderPage();
    const timeline = await screen.findByRole("list", { name: "事件时间线" });
    const items = within(timeline).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("评审完成"),
      expect.stringContaining("已批准"),
      expect.stringContaining("✅ 已合并"),
    ]);
    expect(items[2]).toHaveTextContent("2026-11-04 10:05");
    expect(items[2]).toHaveTextContent("web");
  });

  it("a stale review links to the newer one", async () => {
    fns.fetchReviewDetail.mockResolvedValue(
      ok(aDetailView({ newerReview: { id: "rev-2", shortSha: "ffffeee" } })),
    );
    await renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("PR 有新提交");
    expect(within(alert).getByRole("link", { name: "查看最新评审" })).toHaveAttribute(
      "href",
      "/review/rev-2",
    );
  });

  it("a failed review shows its status and no verdict marker", async () => {
    fns.fetchReviewDetail.mockResolvedValue(
      ok(
        aDetailView({
          review: {
            status: "failed",
            verdict: null,
            marker: null,
            approval: null,
            errorCategory: "upstream_llm",
          },
        }),
      ),
    );
    await renderPage();
    expect(await screen.findByText("评审失败")).toBeInTheDocument();
    expect(screen.getByText(/upstream_llm/)).toBeInTheDocument();
    expect(screen.queryByText(/🟢|🔴|🟡/)).toBeNull();
  });

  it("no GitHub link when the server gives none", async () => {
    fns.fetchReviewDetail.mockResolvedValue(ok(aDetailView({ githubUrl: null })));
    await renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "在 GitHub 打开" })).toBeNull();
  });

  it("unknown id: the 404 view", async () => {
    fns.fetchReviewDetail.mockResolvedValue(fail({ kind: "not_found" }));
    await renderPage("missing");
    expect(
      await screen.findByRole("heading", { level: 1, name: "找不到这条评审" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回评审记录" })).toHaveAttribute("href", "/review");
  });

  it("other errors: generic text with the request id", async () => {
    fns.fetchReviewDetail.mockResolvedValue(
      fail({ kind: "internal", message: "Internal server error." }),
    );
    await renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("评审详情加载失败");
    expect(alert).toHaveTextContent("req-7");
    expect(alert).not.toHaveTextContent("Internal server error.");
  });
});
