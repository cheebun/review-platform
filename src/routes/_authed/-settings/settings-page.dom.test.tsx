import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../../../ui";
import { Route } from "../settings";
import { aRepoView, aSettingsView, FULL, notConfigured } from "./fixtures";
import { SettingsPage } from "./settings-page";

const fns = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  saveGithubTokenFn: vi.fn(),
  removeGithubTokenFn: vi.fn(),
  addRepoFn: vi.fn(),
  removeRepoFn: vi.fn(),
}));
vi.mock("../../../functions/settings", () => fns);
// The Slack section has its own tests (slack/slack-section.dom.test.tsx); here it stays loading.
vi.mock("../../../functions/settings-slack", () => ({
  fetchSlackSettings: () => new Promise(() => undefined),
  saveSlackSecretFn: vi.fn(),
  removeSlackSecretFn: vi.fn(),
  listSlackChannelsFn: vi.fn(),
  setSlackChannelsFn: vi.fn(),
}));
// The LLM section stays loading so only its heading matters here.
vi.mock("../../../functions/settings-llm", () => ({
  fetchLlmSettings: () => new Promise(() => undefined),
  saveAnthropicSettingsFn: vi.fn(),
  testAnthropicSettingsFn: vi.fn(),
  removeLlmSectionFn: vi.fn(),
}));
// The login token section has its own tests (login-token-section.dom.test.tsx).
vi.mock("../../../functions/login-token", () => ({ rotateLoginToken: vi.fn() }));

// A test sentinel, never a real credential.
const TOKEN = "github_pat_DOMSENTINEL0123456789abcdefWXYZ";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPage />
      <Toaster />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

const ok = <T,>(value: T) => ({ ok: true, value });
const fail = (error: Record<string, unknown>) => ({
  ok: false,
  error: { message: "x", requestId: "req-7", ...error },
});

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
});

describe("SettingsPage", () => {
  it("the intro names the remaining sections, and the route renders them in order", async () => {
    fns.fetchSettings.mockResolvedValue(ok(aSettingsView()));
    const RouteComponent = Route.options.component as () => React.ReactNode;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RouteComponent />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/GitHub、Slack 与 LLM 连接/)).toBeInTheDocument();
    await screen.findByRole("heading", { level: 2, name: "GitHub" });
    const order = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(order).toEqual(["GitHub", "Slack", "LLM", "登录令牌"]);
  });

  it("loading, then the GitHub section", async () => {
    let resolve!: (v: unknown) => void;
    fns.fetchSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在加载设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Slack" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "LLM" })).toBeInTheDocument();
    resolve(ok(aSettingsView()));
    expect(await screen.findByRole("heading", { name: "GitHub" })).toBeInTheDocument();
  });

  it("error: generic text with the request id and a retry", async () => {
    fns.fetchSettings.mockResolvedValueOnce(
      fail({ kind: "internal", message: "Internal server error." }),
    );
    const { user } = renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("设置加载失败");
    expect(alert).toHaveTextContent("req-7");
    expect(alert).not.toHaveTextContent("Internal server error.");
    fns.fetchSettings.mockResolvedValueOnce(ok(aSettingsView()));
    await user.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("octocat")).toBeInTheDocument();
  });

  it("not configured: says so, and the repo form is disabled", async () => {
    fns.fetchSettings.mockResolvedValue(ok(notConfigured()));
    renderPage();
    expect(await screen.findByText("GitHub 未配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存 token" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "添加仓库" })).toBeDisabled();
    expect(screen.getByText("未配置仓库。")).toBeInTheDocument();
  });

  it("needs reset: explains and offers to save again", async () => {
    fns.fetchSettings.mockResolvedValue(ok(aSettingsView({ availability: "needs_reset" })));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("需要重新设置");
    expect(screen.getByRole("button", { name: "替换 token" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "添加仓库" })).toBeDisabled();
  });

  it("ready: the connection card shows login, last 4 and kind, never a token", async () => {
    fns.fetchSettings.mockResolvedValue(ok(aSettingsView()));
    renderPage();
    const card = await screen.findByRole("region", { name: "GitHub 连接" });
    expect(card).toHaveTextContent("octocat");
    expect(card).toHaveTextContent("…WXYZ");
    expect(card).toHaveTextContent("Fine-grained");
    expect(card).toHaveTextContent("就绪");
    expect(screen.getByLabelText("GitHub token")).toHaveValue("");
    expect(screen.getByLabelText("GitHub token")).toHaveAttribute("type", "password");
  });

  it("saving: client validation first, then the server; the input is cleared", async () => {
    fns.fetchSettings.mockResolvedValue(ok(notConfigured()));
    fns.saveGithubTokenFn.mockResolvedValue(ok(aSettingsView()));
    const { user } = renderPage();
    const input = await screen.findByLabelText("GitHub token");
    await user.click(screen.getByRole("button", { name: "保存 token" }));
    expect(await screen.findByText("请输入 token。")).toBeInTheDocument();
    expect(fns.saveGithubTokenFn).not.toHaveBeenCalled();

    await user.type(input, TOKEN);
    await user.click(screen.getByRole("button", { name: "保存 token" }));
    await waitFor(() =>
      expect(fns.saveGithubTokenFn).toHaveBeenCalledWith({ data: { token: TOKEN } }),
    );
    expect(await screen.findByText("Token 已保存")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "GitHub 连接" })).toHaveTextContent("octocat");
    expect(input).toHaveValue("");
  });

  it("a token GitHub rejects shows on the field", async () => {
    fns.fetchSettings.mockResolvedValue(ok(notConfigured()));
    fns.saveGithubTokenFn.mockResolvedValue(fail({ kind: "forbidden", field: "token" }));
    const { user } = renderPage();
    await user.type(await screen.findByLabelText("GitHub token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "保存 token" }));
    expect(
      await screen.findByText("GitHub 拒绝了这个 token，请检查它是否有效、是否已过期。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub token")).toHaveAttribute("aria-invalid", "true");
  });

  it("GitHub unavailable: a form alert, nothing saved", async () => {
    fns.fetchSettings.mockResolvedValue(ok(notConfigured()));
    fns.saveGithubTokenFn.mockResolvedValue(fail({ kind: "upstream" }));
    const { user } = renderPage();
    await user.type(await screen.findByLabelText("GitHub token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "保存 token" }));
    expect(await screen.findByText(/无法连接 GitHub/)).toBeInTheDocument();
  });

  it("removing the token asks for confirmation", async () => {
    fns.fetchSettings.mockResolvedValue(ok(aSettingsView()));
    fns.removeGithubTokenFn.mockResolvedValue(ok(notConfigured()));
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "移除 token" }));
    const dialog = await screen.findByRole("dialog");
    expect(fns.removeGithubTokenFn).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(fns.removeGithubTokenFn).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("GitHub 未配置")).toBeInTheDocument();
  });

  it("per-repo status: ✓ ok, ⚠ missing write, ✗ no access, partial and unknown", async () => {
    fns.fetchSettings.mockResolvedValue(
      ok(
        aSettingsView({
          repos: [
            aRepoView({ canonical: "acme/ok" }),
            aRepoView({
              canonical: "acme/ro",
              health: "warning",
              missing: ["contents:write"],
              permissions: { ...FULL, contents: { read: "granted", write: "missing" } },
            }),
            aRepoView({
              canonical: "acme/gone",
              access: "no_access",
              health: "error",
              permissions: null,
            }),
            aRepoView({
              canonical: "acme/part",
              health: "partial",
              permissions: { ...FULL, pullRequests: { read: "granted", write: "unverified" } },
            }),
            aRepoView({
              canonical: "acme/unk",
              access: "unknown",
              health: "unknown",
              permissions: null,
            }),
          ],
        }),
      ),
    );
    renderPage();
    const list = await screen.findByRole("list", { name: "仓库列表" });
    const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
    expect(row("acme/ok")).toHaveTextContent("✓ 正常");
    expect(row("acme/ro")).toHaveTextContent("⚠ 缺少 contents:write");
    expect(row("acme/gone")).toHaveTextContent("✗ 无访问权限");
    expect(row("acme/part")).toHaveTextContent("部分权限无法只读验证");
    expect(row("acme/unk")).toHaveTextContent("未能检查");
    expect(within(row("acme/ro")).getByLabelText("contents:write 缺失")).toBeInTheDocument();
    const unverified = within(row("acme/part")).getByLabelText("pull_requests:write 未验证");
    expect(unverified).toHaveTextContent("⚠ pull_requests:write");
    expect(unverified).toHaveAttribute("title", "⚠ 未验证");
    expect(screen.getByText("5 / 50")).toBeInTheDocument();
  });

  it("adding a repo: format and duplicate checked locally, then the server", async () => {
    fns.fetchSettings.mockResolvedValue(ok(aSettingsView({ repos: [aRepoView()] })));
    fns.addRepoFn.mockResolvedValue(
      ok({
        view: aSettingsView({
          repos: [
            aRepoView(),
            aRepoView({ canonical: "Acme/Api", health: "warning", missing: ["contents:write"] }),
          ],
        }),
        added: aRepoView({ canonical: "Acme/Api" }),
        warnings: ["contents:write"],
      }),
    );
    const { user } = renderPage();
    const input = await screen.findByLabelText("仓库（owner/repo）");
    await user.type(input, "not a repo");
    await user.click(screen.getByRole("button", { name: "添加仓库" }));
    expect(await screen.findByText("格式应为 owner/repo。")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "ACME/WEB");
    expect(await screen.findByText("这个仓库已在列表中。")).toBeInTheDocument();
    expect(fns.addRepoFn).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "acme/api");
    await user.click(screen.getByRole("button", { name: "添加仓库" }));
    await waitFor(() => expect(fns.addRepoFn).toHaveBeenCalledWith({ data: { repo: "acme/api" } }));
    expect(await screen.findByText("已添加 Acme/Api，但缺少：contents:write")).toBeInTheDocument();
    expect(await screen.findByText("Acme/Api")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("a repo the token cannot access shows on the field", async () => {
    fns.fetchSettings.mockResolvedValue(ok(aSettingsView()));
    fns.addRepoFn.mockResolvedValue(fail({ kind: "forbidden", field: "repo" }));
    const { user } = renderPage();
    await user.type(await screen.findByLabelText("仓库（owner/repo）"), "acme/ghost");
    await user.click(screen.getByRole("button", { name: "添加仓库" }));
    expect(await screen.findByText("当前 token 无法访问 acme/ghost。")).toBeInTheDocument();
  });

  it("removing a repo asks for confirmation", async () => {
    fns.fetchSettings.mockResolvedValue(ok(aSettingsView({ repos: [aRepoView()] })));
    fns.removeRepoFn.mockResolvedValue(ok(aSettingsView()));
    const { user } = renderPage();
    await user.click(await screen.findByRole("button", { name: "移除 acme/web" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认移除" }));
    await waitFor(() =>
      expect(fns.removeRepoFn).toHaveBeenCalledWith({ data: { repo: "acme/web" } }),
    );
    expect(await screen.findByText("未配置仓库。")).toBeInTheDocument();
  });
});
