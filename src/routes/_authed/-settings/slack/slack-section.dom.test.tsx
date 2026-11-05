import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../../../../ui";
import { aChannelList, aSlackView, slackNotConfigured } from "./fixtures";
import { SlackSection } from "./slack-section";

const fns = vi.hoisted(() => ({
  fetchSlackSettings: vi.fn(),
  saveSlackSecretFn: vi.fn(),
  removeSlackSecretFn: vi.fn(),
  listSlackChannelsFn: vi.fn(),
  setSlackChannelsFn: vi.fn(),
}));
vi.mock("../../../../functions/settings-slack", () => fns);

// Test sentinels, never real credentials.
const USER_TOKEN = "xoxp-0000-FAKE-dom-user-token-00AB12";
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SlackSection />
      <Toaster />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

const ok = <T,>(value: T) => ({ ok: true, value });
const fail = (error: Record<string, unknown>) => ({
  ok: false,
  error: { message: "x", requestId: "req-9", ...error },
});

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
  fns.listSlackChannelsFn.mockResolvedValue(ok(aChannelList()));
});

describe("SlackSection", () => {
  it("offers only HTTP Events API credentials", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(slackNotConfigured()));
    renderSection();
    expect(await screen.findByRole("region", { name: "Signing secret" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "User token" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "App-level token" })).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("App-level token", { selector: "input" }),
    ).not.toBeInTheDocument();
  });

  it("loading, then the section heading", async () => {
    let resolve!: (v: unknown) => void;
    fns.fetchSlackSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSection();
    expect(screen.getByRole("status", { name: "正在加载 Slack 设置" })).toBeInTheDocument();
    resolve(ok(aSlackView()));
    expect(await screen.findByRole("heading", { name: "Slack" })).toBeInTheDocument();
  });

  it("load error: generic text with the request id and a retry", async () => {
    fns.fetchSlackSettings.mockResolvedValueOnce(fail({ kind: "internal", message: "boom" }));
    const { user } = renderSection();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Slack 设置加载失败");
    expect(alert).toHaveTextContent("req-9");
    expect(alert).not.toHaveTextContent("boom");
    fns.fetchSlackSettings.mockResolvedValueOnce(ok(aSlackView()));
    await user.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("region", { name: "User token" })).toBeInTheDocument();
  });

  it("not configured: says so, does not list channels", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(slackNotConfigured()));
    renderSection();
    expect(await screen.findByText("Slack 未配置")).toBeInTheDocument();
    for (const name of ["User token", "Signing secret"]) {
      expect(within(screen.getByRole("region", { name })).getByText("未设置")).toBeInTheDocument();
    }
    expect(fns.listSlackChannelsFn).not.toHaveBeenCalled();
    expect(screen.getByText(/保存 user token 后可选择频道/)).toBeInTheDocument();
  });

  it("needs reset: explains", async () => {
    fns.fetchSlackSettings.mockResolvedValue(
      ok(
        aSlackView({
          availability: "needs_reset",
          secrets: {
            ...aSlackView().secrets,
            slack_signing_secret: {
              state: "needs_reset",
              last4: "0004",
              savedAt: "2026-11-04T03:00:00.000Z",
              verifiedAt: null,
            },
          },
        }),
      ),
    );
    renderSection();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("需要重新设置"))).toBe(true);
    expect(
      within(screen.getByRole("region", { name: "Signing secret" })).getByText("需要重新设置"),
    ).toBeInTheDocument();
  });

  it("shows status and last 4 only; ⚠ 未验证 where unverified", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    renderSection();
    const userCard = await screen.findByRole("region", { name: "User token" });
    expect(userCard).toHaveTextContent("…AB12");
    expect(userCard).toHaveTextContent("✓ 已验证");
    expect(userCard).toHaveTextContent("Acme");
    const signing = screen.getByRole("region", { name: "Signing secret" });
    expect(signing).toHaveTextContent("…cdef");
    expect(signing).toHaveTextContent("⚠ 未验证");
    for (const input of screen.getAllByLabelText(/token|secret/i, { selector: "input" })) {
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveValue("");
    }
  });

  it("saving a secret: client check first, then the server; the input is cleared", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(slackNotConfigured()));
    fns.saveSlackSecretFn.mockResolvedValue(ok(aSlackView()));
    const { user } = renderSection();
    const region = await screen.findByRole("region", { name: "User token" });
    const input = within(region).getByLabelText("User token", { selector: "input" });
    await user.type(input, "xoxb-0000-FAKE-bot-token-000000");
    await user.click(within(region).getByRole("button", { name: "保存" }));
    expect(await within(region).findByText(/以 xoxp- 开头/)).toBeInTheDocument();
    expect(fns.saveSlackSecretFn).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, USER_TOKEN);
    await user.click(within(region).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(fns.saveSlackSecretFn).toHaveBeenCalledWith({
        data: { kind: "slack_user_token", value: USER_TOKEN },
      }),
    );
    expect(await screen.findByText("User token 已保存")).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(""));
    expect(document.body).not.toHaveTextContent(USER_TOKEN);
  });

  it("a value Slack rejects is shown on its field", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    fns.saveSlackSecretFn.mockResolvedValue(
      fail({ kind: "forbidden", field: "userToken", fieldMessage: "Token rejected by Slack." }),
    );
    const { user } = renderSection();
    const region = await screen.findByRole("region", { name: "User token" });
    await user.type(within(region).getByLabelText("User token", { selector: "input" }), USER_TOKEN);
    await user.click(within(region).getByRole("button", { name: "替换" }));
    expect(await within(region).findByText(/Slack 拒绝了这个值/)).toBeInTheDocument();
  });

  it("an upstream failure is a form error with the request id", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    fns.saveSlackSecretFn.mockResolvedValue(fail({ kind: "upstream" }));
    const { user } = renderSection();
    const region = await screen.findByRole("region", { name: "Signing secret" });
    await user.type(
      within(region).getByLabelText("Signing secret", { selector: "input" }),
      SIGNING_SECRET,
    );
    await user.click(within(region).getByRole("button", { name: "替换" }));
    const error = await within(region).findByRole("alert");
    expect(error).toHaveTextContent("无法连接 Slack");
    expect(error).toHaveTextContent("req-9");
  });

  it("removing a secret asks first", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    fns.removeSlackSecretFn.mockResolvedValue(ok(slackNotConfigured()));
    const { user } = renderSection();
    const region = await screen.findByRole("region", { name: "User token" });
    await user.click(within(region).getByRole("button", { name: "移除" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认移除" }));
    await waitFor(() =>
      expect(fns.removeSlackSecretFn).toHaveBeenCalledWith({ data: { kind: "slack_user_token" } }),
    );
    expect(await screen.findByText("Slack 未配置")).toBeInTheDocument();
  });
});

describe("channel picker", () => {
  it("lists channels, filters by name, and states the rule", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    const { user } = renderSection();
    const picker = await screen.findByRole("group", { name: "评审频道" });
    expect(await within(picker).findByLabelText("#general")).not.toBeChecked();
    expect(within(picker).getByLabelText("🔒 ops-private")).toBeInTheDocument();
    expect(screen.getByText("空选择 = 所有频道。私信始终计入。")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "搜索频道" }), "#RAN");
    expect(within(picker).queryByLabelText("#general")).not.toBeInTheDocument();
    expect(within(picker).getByLabelText("#random")).toBeInTheDocument();
  });

  it("saves the multi-selection", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    fns.setSlackChannelsFn.mockResolvedValue(
      ok(
        aSlackView({
          channels: [
            { channelId: "C1AA", name: "general", missing: false, checkedAt: null },
            { channelId: "C3CC", name: "random", missing: false, checkedAt: null },
          ],
        }),
      ),
    );
    const { user } = renderSection();
    const picker = await screen.findByRole("group", { name: "评审频道" });
    await user.click(await within(picker).findByLabelText("#general"));
    await user.click(within(picker).getByLabelText("#random"));
    expect(screen.getByText("已选 2 个频道")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存频道" }));
    await waitFor(() =>
      expect(fns.setSlackChannelsFn).toHaveBeenCalledWith({
        data: { channels: ["C1AA", "C3CC"] },
      }),
    );
    expect(await screen.findByText("评审频道已保存")).toBeInTheDocument();
  });

  it("an empty selection reads as all channels", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    renderSection();
    expect(await screen.findByText("未选择：所有频道都计入")).toBeInTheDocument();
  });

  it("flags a selected channel that is gone and keeps it selectable", async () => {
    fns.fetchSlackSettings.mockResolvedValue(
      ok(
        aSlackView({
          channels: [{ channelId: "C9ZZ", name: "old-team", missing: true, checkedAt: null }],
        }),
      ),
    );
    renderSection();
    const picker = await screen.findByRole("group", { name: "评审频道" });
    const gone = await within(picker).findByLabelText(/#old-team/);
    expect(gone).toBeChecked();
    expect(picker).toHaveTextContent("⚠ 已不可访问");
  });

  it("a listing failure is shown with a retry; truncation is noted", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    fns.listSlackChannelsFn.mockResolvedValueOnce(fail({ kind: "rate_limited" }));
    const { user } = renderSection();
    const alert = await screen.findByText(/频道列表加载失败/);
    fns.listSlackChannelsFn.mockResolvedValueOnce(ok(aChannelList({ truncated: true })));
    await user.click(
      within(alert.closest("[role]") as HTMLElement).getByRole("button", { name: "重试" }),
    );
    expect(await screen.findByText(/频道过多/)).toBeInTheDocument();
  });

  it("a channel save error is shown", async () => {
    fns.fetchSlackSettings.mockResolvedValue(ok(aSlackView()));
    fns.setSlackChannelsFn.mockResolvedValue(
      fail({ kind: "validation", field: "channels", fieldMessage: "x" }),
    );
    const { user } = renderSection();
    const picker = await screen.findByRole("group", { name: "评审频道" });
    await user.click(await within(picker).findByLabelText("#general"));
    await user.click(screen.getByRole("button", { name: "保存频道" }));
    expect(await screen.findByText(/只能选择你已加入的频道/)).toBeInTheDocument();
  });
});
