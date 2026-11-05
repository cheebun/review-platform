import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SetupFnResult } from "../../functions/setup.logic";
import type { SetupClient } from "./setup-client";
import { SetupWizard } from "./setup-wizard";

const LOGIN = "correct horse battery";
const API_KEY = "test-anthropic-app-key-0000-AK01";
const GH_TOKEN = "github_pat_SENTINEL0123456789abcdefWXYZ";
const SLACK_TOKEN = "xoxp-0000-FAKE-app-user-token-0001";

const failure = (kind: string, extra: Record<string, unknown> = {}): SetupFnResult<never> => ({
  ok: false,
  error: { kind, message: "RAW server text", requestId: "r1", ...extra } as never,
});

function makeClient(overrides: Partial<SetupClient> = {}): {
  [K in keyof SetupClient]: ReturnType<typeof vi.fn<SetupClient[K]>>;
} {
  return {
    sections: vi.fn<SetupClient["sections"]>(async () => ({
      ok: true,
      value: { anthropic: false, github: false, slack: false },
    })),
    testAnthropic: vi.fn<SetupClient["testAnthropic"]>(async () => ({
      ok: true,
      value: { verdict: "verified", model: "claude-haiku-5-5", latencyMs: 12 },
    })),
    listGithubRepos: vi.fn<SetupClient["listGithubRepos"]>(async () => ({
      ok: true,
      value: {
        login: "octocat",
        repos: [
          { fullName: "acme/api", private: true, canPush: true },
          { fullName: "acme/web", private: false, canPush: true },
        ],
        truncated: false,
      },
    })),
    testSlack: vi.fn<SetupClient["testSlack"]>(async () => ({
      ok: true,
      value: { teamName: "Acme" },
    })),
    finish: vi.fn<SetupClient["finish"]>(async () => ({ ok: true, value: null })),
    ...Object.fromEntries(Object.entries(overrides).map(([k, fn]) => [k, vi.fn(fn)])),
  } as never;
}

function setup(client = makeClient()) {
  const onDone = vi.fn();
  const toLogin = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SetupWizard client={client} onDone={onDone} toLogin={toLogin} />
    </QueryClientProvider>,
  );
  return { client, onDone, toLogin, view, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;

const heading = (name: string) => screen.findByRole("heading", { level: 2, name });
const button = (name: string) => screen.getByRole("button", { name });

async function tokenStep(user: User) {
  await user.type(screen.getByLabelText("登录令牌"), LOGIN);
  await user.type(screen.getByLabelText("再次输入登录令牌"), LOGIN);
  await user.click(button("下一步"));
  await heading("AI");
}

async function anthropicStep(user: User) {
  await user.type(screen.getByLabelText("API key"), API_KEY);
  await user.click(button("下一步"));
  await heading("GitHub");
}

async function githubStep(user: User) {
  await user.type(screen.getByLabelText("GitHub 令牌"), GH_TOKEN);
  await user.click(button("验证并加载仓库"));
  await user.click(await screen.findByRole("checkbox", { name: /acme\/api/ }));
  await user.click(button("下一步"));
  await heading("Slack");
}

async function slackStep(user: User) {
  await user.type(screen.getByLabelText("User token"), SLACK_TOKEN);
}

describe("SetupWizard (FR-AUTH-01)", () => {
  it("collects every step in memory and calls finishSetup once, on 完成", async () => {
    const { client, onDone, user } = setup();
    await tokenStep(user);
    await anthropicStep(user);
    await githubStep(user);
    await slackStep(user);
    expect(client.finish).not.toHaveBeenCalled();
    await user.click(button("完成"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(client.finish).toHaveBeenCalledTimes(1);
    expect(client.finish).toHaveBeenCalledWith({
      token: LOGIN,
      confirm: LOGIN,
      anthropic: { apiKey: API_KEY },
      github: { token: GH_TOKEN, repos: ["acme/api"] },
      slack: { userToken: SLACK_TOKEN },
    });
  });

  it("calls nothing but the setup-only checks before 完成", async () => {
    const { client, user } = setup();
    await tokenStep(user);
    await user.type(screen.getByLabelText("API key"), API_KEY);
    await user.click(button("测试连接"));
    expect(await screen.findByText(/连接成功/)).toBeInTheDocument();
    await user.click(button("下一步"));
    await heading("GitHub");
    await user.type(screen.getByLabelText("GitHub 令牌"), GH_TOKEN);
    await user.click(button("验证并加载仓库"));
    await screen.findByRole("checkbox", { name: /acme\/api/ });
    await user.click(button("下一步"));
    await heading("Slack");
    await slackStep(user);
    await user.click(button("测试连接"));
    expect(await screen.findByText(/Acme/)).toBeInTheDocument();
    expect(client.testAnthropic).toHaveBeenCalledWith({ apiKey: API_KEY });
    expect(client.listGithubRepos).toHaveBeenCalledWith(GH_TOKEN);
    expect(client.testSlack).toHaveBeenCalledWith(SLACK_TOKEN);
    expect(client.finish).not.toHaveBeenCalled();
  });

  it("checks the token on 下一步 without calling the server", async () => {
    const { client, user } = setup();
    await user.type(screen.getByLabelText("登录令牌"), "abc");
    await user.type(screen.getByLabelText("再次输入登录令牌"), "abd");
    await user.click(button("下一步"));
    expect(await screen.findByText(/至少 6 个字符/, { selector: "p[id]" })).toBeInTheDocument();
    expect(screen.getByText("两次输入的登录令牌不一致")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "设置登录令牌" })).toBeInTheDocument();
    expect(client.finish).not.toHaveBeenCalled();
  });

  it("keeps the values across 上一步 and 下一步", async () => {
    const { user } = setup();
    await tokenStep(user);
    await anthropicStep(user);
    await user.type(screen.getByLabelText("GitHub 令牌"), GH_TOKEN);
    await user.click(button("上一步"));
    await heading("AI");
    expect(screen.getByLabelText("API key")).toHaveValue(API_KEY);
    await user.click(button("上一步"));
    await heading("设置登录令牌");
    expect(screen.getByLabelText("登录令牌")).toHaveValue(LOGIN);
    expect(screen.getByLabelText("再次输入登录令牌")).toHaveValue(LOGIN);
    await user.click(button("下一步"));
    await user.click(button("下一步"));
    await heading("GitHub");
    expect(screen.getByLabelText("GitHub 令牌")).toHaveValue(GH_TOKEN);
  });

  it("稍后配置 omits that section, even when it has values", async () => {
    const { client, user } = setup();
    await tokenStep(user);
    await user.type(screen.getByLabelText("API key"), API_KEY);
    await user.click(button("稍后配置"));
    await heading("GitHub");
    await user.click(button("稍后配置"));
    await heading("Slack");
    await user.click(button("稍后配置并完成"));
    await waitFor(() => expect(client.finish).toHaveBeenCalledTimes(1));
    expect(client.finish).toHaveBeenCalledWith({ token: LOGIN, confirm: LOGIN });
  });

  it("a reload starts again at step 1 with nothing filled in, and says so", async () => {
    const first = setup();
    await tokenStep(first.user);
    await first.user.type(screen.getByLabelText("API key"), API_KEY);
    first.view.unmount();
    setup();
    expect(await heading("设置登录令牌")).toBeInTheDocument();
    expect(screen.getByLabelText("登录令牌")).toHaveValue("");
    expect(screen.getByText(/刷新页面会清空/)).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("a validation error jumps to its step and shows inline", async () => {
    const client = makeClient({
      finish: async () =>
        failure("forbidden", { field: "github.repos", fieldMessage: "The token cannot access x." }),
    });
    const { user, onDone } = setup(client);
    await tokenStep(user);
    await anthropicStep(user);
    await githubStep(user);
    await slackStep(user);
    await user.click(button("完成"));
    expect(await heading("GitHub")).toBeInTheDocument();
    expect(await screen.findByText("令牌无法访问所选的仓库")).toBeInTheDocument();
    expect(screen.queryByText(/RAW server text|cannot access/)).not.toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a token error from the server jumps back to step 1", async () => {
    const client = makeClient({
      finish: async () => failure("validation", { field: "confirm", fieldMessage: "x" }),
    });
    const { user } = setup(client);
    await tokenStep(user);
    await user.click(button("稍后配置"));
    await user.click(button("稍后配置"));
    await user.click(button("稍后配置并完成"));
    expect(await heading("设置登录令牌")).toBeInTheDocument();
    expect(screen.getByText("两次输入的登录令牌不一致")).toBeInTheDocument();
  });

  it("409: someone else finished setup first; offers the login page", async () => {
    const client = makeClient({ finish: async () => failure("conflict") });
    const { user, toLogin } = setup(client);
    await tokenStep(user);
    await user.click(button("稍后配置"));
    await user.click(button("稍后配置"));
    await user.click(button("稍后配置并完成"));
    const alert = await screen.findByText("系统已初始化");
    await user.click(
      within(alert.closest("[role]") ?? document.body).getByRole("button", {
        name: "前往登录",
      }),
    );
    expect(toLogin).toHaveBeenCalledTimes(1);
  });

  it("a failure without a field stays on the step with a generic message", async () => {
    const client = makeClient({ finish: async () => failure("internal") });
    const { user, onDone } = setup(client);
    await tokenStep(user);
    await user.click(button("稍后配置"));
    await user.click(button("稍后配置"));
    await user.click(button("稍后配置并完成"));
    expect(await screen.findByText("完成设置失败，请稍后重试。")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("marks sections that already have stored values as 已配置", async () => {
    const client = makeClient({
      sections: async () => ({ ok: true, value: { anthropic: false, github: true, slack: false } }),
    });
    const { user } = setup(client);
    await tokenStep(user);
    expect(screen.queryByText("已配置")).not.toBeInTheDocument();
    await user.click(button("稍后配置"));
    await heading("GitHub");
    expect(screen.getByText("已配置")).toBeInTheDocument();
  });

  it("a double click on 完成 submits once", async () => {
    let release: ((v: SetupFnResult<null>) => void) | undefined;
    const client = makeClient({
      finish: () => new Promise((resolve) => (release = resolve)),
    });
    const { user } = setup(client);
    await tokenStep(user);
    await user.click(button("稍后配置"));
    await user.click(button("稍后配置"));
    await slackStep(user);
    const done = button("完成");
    await user.dblClick(done);
    release?.({ ok: true, value: null });
    await waitFor(() => expect(client.finish).toHaveBeenCalledTimes(1));
  });
});
