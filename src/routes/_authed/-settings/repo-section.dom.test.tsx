import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../../../application/settings/view";
import { Toaster } from "../../../ui";
import { aRepoView, aSettingsView, notConfigured } from "./fixtures";
import { RepoSection } from "./repo-section";

const fns = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  saveGithubTokenFn: vi.fn(),
  removeGithubTokenFn: vi.fn(),
  addRepoFn: vi.fn(),
  removeRepoFn: vi.fn(),
}));
vi.mock("../../../functions/settings", () => fns);
const gh = vi.hoisted(() => ({ fetchGithubAccessibleRepos: vi.fn() }));
vi.mock("../../../functions/settings-github", () => gh);

const ok = <T,>(value: T) => ({ ok: true, value });
const fail = (error: Record<string, unknown>) => ({
  ok: false,
  error: { message: "x", requestId: "req-3", ...error },
});

const LISTING = {
  repos: [
    { fullName: "acme/api", private: true, canPush: true },
    { fullName: "acme/web", private: false, canPush: true },
    { fullName: "Other/Docs", private: false, canPush: false },
  ],
  truncated: false,
};

function renderSection(view: SettingsView = aSettingsView({ repos: [aRepoView()] })) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RepoSection view={view} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), client };
}

const refreshButton = () => screen.getByRole("button", { name: "从 GitHub 拉取仓库" });
const input = () => screen.getByRole("combobox", { name: "仓库（owner/repo）" });

const added = (canonical: string) =>
  ok({
    view: aSettingsView({ repos: [aRepoView(), aRepoView({ canonical })] }),
    added: aRepoView({ canonical }),
    warnings: [],
  });

beforeEach(() => {
  for (const fn of [...Object.values(fns), ...Object.values(gh)]) fn.mockReset();
  gh.fetchGithubAccessibleRepos.mockResolvedValue(ok(LISTING));
});

describe("RepoSection repo picker", () => {
  it("does not fetch on load; the refresh button is labelled", async () => {
    renderSection();
    expect(refreshButton()).toBeEnabled();
    expect(input()).toBeInTheDocument();
    await Promise.resolve();
    expect(gh.fetchGithubAccessibleRepos).not.toHaveBeenCalled();
  });

  it("refresh: disabled and spinning while loading, then the list opens", async () => {
    let resolve!: (v: unknown) => void;
    gh.fetchGithubAccessibleRepos.mockReturnValue(new Promise((r) => (resolve = r)));
    const { user } = renderSection();
    await user.click(refreshButton());
    expect(refreshButton()).toBeDisabled();
    expect(refreshButton()).toHaveAttribute("aria-busy", "true");
    expect(refreshButton().querySelector("svg")).toHaveClass("motion-safe:animate-spin");
    resolve(ok(LISTING));
    const list = await screen.findByRole("listbox");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining("acme/api"),
      expect.stringContaining("acme/web"),
      expect.stringContaining("Other/Docs"),
    ]);
    expect(gh.fetchGithubAccessibleRepos).toHaveBeenCalledTimes(1);
    // The open popup hides its siblings from assistive tech; Escape closes it.
    await user.keyboard("{Escape}");
    expect(refreshButton()).toBeEnabled();
    expect(refreshButton().querySelector("svg")).not.toHaveClass("motion-safe:animate-spin");
  });

  it("a second refresh refetches even while the list is fresh", async () => {
    const { user } = renderSection();
    await user.click(refreshButton());
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    await user.click(refreshButton());
    await waitFor(() => expect(gh.fetchGithubAccessibleRepos).toHaveBeenCalledTimes(2));
  });

  it("typing filters the list by name, case-insensitively", async () => {
    const { user } = renderSection();
    await user.click(refreshButton());
    await screen.findByRole("listbox");
    await user.type(input(), "DOC");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        expect.stringContaining("Other/Docs"),
      ]),
    );
  });

  it("badges: read-only warns, private is marked, already-added is disabled", async () => {
    const { user } = renderSection();
    await user.click(refreshButton());
    const list = await screen.findByRole("listbox");
    const option = (name: string) =>
      within(list)
        .getAllByRole("option")
        .find((o) => o.textContent?.includes(name)) as HTMLElement;
    expect(option("Other/Docs")).toHaveTextContent("⚠ 只读");
    expect(option("acme/api")).not.toHaveTextContent("只读");
    expect(option("acme/api")).toHaveTextContent("私有");
    expect(option("acme/web")).toHaveTextContent("已添加");
    expect(option("acme/web")).toHaveAttribute("aria-disabled", "true");
  });

  it("selecting an item adds that repo", async () => {
    fns.addRepoFn.mockResolvedValue(added("acme/api"));
    const { user } = renderSection();
    await user.click(refreshButton());
    const list = await screen.findByRole("listbox");
    await user.click(within(list).getByText("acme/api"));
    await waitFor(() => expect(fns.addRepoFn).toHaveBeenCalledWith({ data: { repo: "acme/api" } }));
    expect(await screen.findByText("已添加 acme/api")).toBeInTheDocument();
    expect(input()).toHaveValue("");
  });

  it("free-form owner/repo + Enter adds it when the list does not have it", async () => {
    fns.addRepoFn.mockResolvedValue(added("zeta/tool"));
    const { user } = renderSection();
    await user.click(refreshButton());
    await screen.findByRole("listbox");
    await user.type(input(), "zeta/tool{Enter}");
    await waitFor(() =>
      expect(fns.addRepoFn).toHaveBeenCalledWith({ data: { repo: "zeta/tool" } }),
    );
  });

  it("free-form + Enter works with no list fetched, with the same validation", async () => {
    fns.addRepoFn.mockResolvedValue(added("zeta/tool"));
    const { user } = renderSection();
    await user.type(input(), "not a repo{Enter}");
    expect(await screen.findByText("格式应为 owner/repo。")).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "ACME/WEB");
    expect(await screen.findByText("这个仓库已在列表中。")).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "zeta/tool{Enter}");
    await waitFor(() =>
      expect(fns.addRepoFn).toHaveBeenCalledWith({ data: { repo: "zeta/tool" } }),
    );
    expect(gh.fetchGithubAccessibleRepos).not.toHaveBeenCalled();
  });

  it("no token on the server: asks to save a GitHub token first", async () => {
    gh.fetchGithubAccessibleRepos.mockResolvedValue(fail({ kind: "not_configured" }));
    const { user } = renderSection();
    await user.click(refreshButton());
    expect(await screen.findByText("请先保存 GitHub token")).toBeInTheDocument();
  });

  it("an undecryptable token or a rejected one: says what to do", async () => {
    gh.fetchGithubAccessibleRepos.mockResolvedValueOnce(
      fail({ kind: "not_configured", reason: "needs_reset" }),
    );
    const { user } = renderSection();
    await user.click(refreshButton());
    expect(await screen.findByText(/无法解密，请重新保存/)).toBeInTheDocument();
    gh.fetchGithubAccessibleRepos.mockResolvedValueOnce(fail({ kind: "forbidden" }));
    await user.click(refreshButton());
    expect(await screen.findByText(/GitHub 拒绝了已保存的 token/)).toBeInTheDocument();
  });

  it("a truncated list says so", async () => {
    gh.fetchGithubAccessibleRepos.mockResolvedValue(ok({ ...LISTING, truncated: true }));
    const { user } = renderSection();
    await user.click(refreshButton());
    expect(await screen.findByText("列表不完整，可直接输入 owner/repo")).toBeInTheDocument();
  });

  it("without a usable token the refresh button is disabled", () => {
    renderSection(notConfigured());
    expect(refreshButton()).toBeDisabled();
  });
});
