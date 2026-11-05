import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../../../../ui";
import { anLlmView, llmNotConfigured } from "./fixtures";
import { LlmSection } from "./llm-section";

const fns = vi.hoisted(() => ({
  fetchLlmSettings: vi.fn(),
  saveAnthropicSettingsFn: vi.fn(),
  testAnthropicSettingsFn: vi.fn(),
  removeLlmSectionFn: vi.fn(),
}));
vi.mock("../../../../functions/settings-llm", () => fns);

// Test sentinels, never real credentials.
const A_KEY = "test-anthropic-dom-key-00000-AK01";

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LlmSection />
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
const saved = (view = anLlmView()) => ok({ view });

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset();
});

describe("LlmSection", () => {
  it("loading, then the section heading", async () => {
    let resolve!: (v: unknown) => void;
    fns.fetchLlmSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSection();
    expect(screen.getByRole("status", { name: "正在加载 LLM 设置" })).toBeInTheDocument();
    resolve(ok(anLlmView()));
    expect(await screen.findByRole("heading", { name: "LLM" })).toBeInTheDocument();
  });

  it("load error: generic text with the request id and a retry", async () => {
    fns.fetchLlmSettings.mockResolvedValueOnce(fail({ kind: "internal", message: "boom" }));
    const { user } = renderSection();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("LLM 设置加载失败");
    expect(alert).toHaveTextContent("req-9");
    expect(alert).not.toHaveTextContent("boom");
    fns.fetchLlmSettings.mockResolvedValueOnce(ok(anLlmView()));
    await user.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("region", { name: "Anthropic" })).toBeInTheDocument();
  });

  it("not configured: shows one Anthropic form without provider selection", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(llmNotConfigured()));
    renderSection();
    expect(await screen.findByText("LLM 未配置")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "OpenAI" })).not.toBeInTheDocument();
    const connection = screen.getByRole("region", { name: "Anthropic" });
    expect(within(connection).getByText("未设置")).toBeInTheDocument();
    expect(screen.getAllByRole("form")).toHaveLength(1);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("needs reset: explains", async () => {
    fns.fetchLlmSettings.mockResolvedValue(
      ok(
        anLlmView({
          availability: "needs_reset",
          active: null,
          anthropic: {
            ...anLlmView().anthropic,
            credential: {
              ...(anLlmView().anthropic.credential as object),
              state: "needs_reset",
            } as never,
          },
        }),
      ),
    );
    renderSection();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("需要重新设置"))).toBe(true);
  });

  it("shows the active provider, last 4, verification, model and latency; never a value", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(anLlmView()));
    renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    expect(card).toHaveTextContent("使用中");
    expect(card).toHaveTextContent("…AK01");
    expect(card).toHaveTextContent("✓ 已验证");
    expect(card).toHaveTextContent("321 ms");
    expect(within(card).getByLabelText("Base URL")).toHaveValue("https://gateway.example.test");
    for (const input of screen.getAllByLabelText(/key|token/i, { selector: "input" })) {
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveValue("");
    }
  });

  it("Anthropic: a client check first, then the server with the form; the key is cleared", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(llmNotConfigured()));
    fns.saveAnthropicSettingsFn.mockResolvedValue(saved());
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    const baseUrl = within(card).getByLabelText("Base URL");
    await user.type(baseUrl, "ftp://nope");
    await user.type(within(card).getByLabelText("API key", { selector: "input" }), A_KEY);
    await user.click(within(card).getByRole("button", { name: "保存" }));
    expect(await within(card).findByText(/http 或 https/)).toBeInTheDocument();
    expect(fns.saveAnthropicSettingsFn).not.toHaveBeenCalled();

    await user.clear(baseUrl);
    await user.type(baseUrl, "https://gateway.example.test");
    await user.click(within(card).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(fns.saveAnthropicSettingsFn).toHaveBeenCalledWith({
        data: {
          baseUrl: "https://gateway.example.test",
          model: "",
          apiKey: A_KEY,
        },
      }),
    );
    expect(await screen.findByText(/Anthropic 设置已保存/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(card).getByLabelText("API key", { selector: "input" })).toHaveValue(""),
    );
    expect(document.body).not.toHaveTextContent(A_KEY);
  });

  it("no key typed and none stored: asks for one, no server call", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(llmNotConfigured()));
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.click(within(card).getByRole("button", { name: "保存" }));
    expect(await within(card).findByText(/请填写 API key 或 auth token/)).toBeInTheDocument();
    expect(fns.saveAnthropicSettingsFn).not.toHaveBeenCalled();
  });

  it("a stored key may be kept: the save sends no credential", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(anLlmView()));
    fns.saveAnthropicSettingsFn.mockResolvedValue(saved());
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.type(within(card).getByLabelText("模型"), "claude-x");
    await user.click(within(card).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fns.saveAnthropicSettingsFn).toHaveBeenCalledTimes(1));
    const data = fns.saveAnthropicSettingsFn.mock.calls[0]![0].data;
    expect(data).toMatchObject({ model: "claude-x" });
    expect(data).not.toHaveProperty("apiKey");
    expect(data).not.toHaveProperty("authToken");
  });

  it("rejected credentials are shown on the key field", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(llmNotConfigured()));
    fns.saveAnthropicSettingsFn.mockResolvedValue(fail({ kind: "forbidden", field: "apiKey" }));
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.type(within(card).getByLabelText("API key", { selector: "input" }), A_KEY);
    await user.click(within(card).getByRole("button", { name: "保存" }));
    expect(await within(card).findByText(/LLM 服务拒绝了这个凭据/)).toBeInTheDocument();
  });

  it("testing uses unsaved inputs without saving or clearing the key", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(llmNotConfigured()));
    fns.testAnthropicSettingsFn.mockResolvedValue(
      ok({ verdict: "verified", model: "claude-haiku-5-5", latencyMs: 12 }),
    );
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.type(within(card).getByLabelText("API key", { selector: "input" }), A_KEY);
    await user.type(within(card).getByLabelText("模型"), "unsaved-model");
    await user.click(within(card).getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(fns.testAnthropicSettingsFn).toHaveBeenCalledWith({
        data: { apiKey: A_KEY, model: "unsaved-model", baseUrl: "" },
      }),
    );
    expect(fns.saveAnthropicSettingsFn).not.toHaveBeenCalled();
    expect(within(card).getByLabelText("API key", { selector: "input" })).toHaveValue(A_KEY);
    expect(within(card).getByLabelText("模型")).toHaveValue("unsaved-model");
    expect(await screen.findByText(/连接测试成功/)).toHaveTextContent("claude-haiku-5-5");
    expect(within(card).queryByLabelText("认证头")).not.toBeInTheDocument();
    expect(within(card).queryByLabelText("服务端回退")).not.toBeInTheDocument();
  });

  it("a failed test leaves Save usable with the same inputs", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(llmNotConfigured()));
    fns.testAnthropicSettingsFn.mockResolvedValue(fail({ kind: "forbidden", field: "apiKey" }));
    fns.saveAnthropicSettingsFn.mockResolvedValue(saved());
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.type(within(card).getByLabelText("API key", { selector: "input" }), A_KEY);
    await user.click(within(card).getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/连接测试失败/)).toBeInTheDocument();
    expect(fns.saveAnthropicSettingsFn).not.toHaveBeenCalled();
    await user.click(within(card).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fns.saveAnthropicSettingsFn).toHaveBeenCalledTimes(1));
  });

  it("tests with the saved masked key without sending it to the browser", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(anLlmView()));
    fns.testAnthropicSettingsFn.mockResolvedValue(
      ok({ verdict: "verified", model: "claude-haiku-5-5", latencyMs: 12 }),
    );
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.click(within(card).getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(fns.testAnthropicSettingsFn).toHaveBeenCalledWith({
        data: { baseUrl: "https://gateway.example.test", model: "" },
      }),
    );
    expect(fns.saveAnthropicSettingsFn).not.toHaveBeenCalled();
  });

  it("a test that verifies the saved settings flips the badge without a reload", async () => {
    const unverified = anLlmView();
    if (unverified.anthropic.credential.state === "set")
      unverified.anthropic.credential.verifiedAt = null;
    fns.fetchLlmSettings.mockResolvedValue(ok(unverified));
    fns.testAnthropicSettingsFn.mockResolvedValue(
      ok({ verdict: "verified", model: "claude-haiku-5-5", latencyMs: 12, view: anLlmView() }),
    );
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    expect(within(card).getByText("⚠ 未验证")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "测试连接" }));
    expect(await within(card).findByText("✓ 已验证")).toBeInTheDocument();
    expect(within(card).queryByText("⚠ 未验证")).not.toBeInTheDocument();
    expect(fns.fetchLlmSettings).toHaveBeenCalledTimes(1);
  });

  it("a test of an unsaved draft keeps the badge and the typed inputs", async () => {
    const unverified = anLlmView();
    if (unverified.anthropic.credential.state === "set")
      unverified.anthropic.credential.verifiedAt = null;
    fns.fetchLlmSettings.mockResolvedValue(ok(unverified));
    fns.testAnthropicSettingsFn.mockResolvedValue(
      ok({ verdict: "verified", model: "claude-haiku-5-5", latencyMs: 12, view: null }),
    );
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.type(within(card).getByLabelText("API key", { selector: "input" }), A_KEY);
    await user.click(within(card).getByRole("button", { name: "测试连接" }));
    expect((await screen.findAllByText(/连接测试成功/)).length).toBeGreaterThan(0);
    expect(within(card).getByText("⚠ 未验证")).toBeInTheDocument();
    expect(within(card).getByLabelText("API key", { selector: "input" })).toHaveValue(A_KEY);
  });

  it("switching credential type requires a new token and saves it as authToken", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(anLlmView()));
    fns.saveAnthropicSettingsFn.mockResolvedValue(saved());
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.click(within(card).getByRole("combobox", { name: "凭据类型" }));
    await user.click(await screen.findByRole("option", { name: "Auth token" }));
    await user.click(within(card).getByRole("button", { name: "保存" }));
    expect(await within(card).findByText(/请填写 API key 或 auth token/)).toBeInTheDocument();
    expect(fns.saveAnthropicSettingsFn).not.toHaveBeenCalled();
    await user.type(within(card).getByLabelText("Auth token", { selector: "input" }), A_KEY);
    await user.click(within(card).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(fns.saveAnthropicSettingsFn).toHaveBeenCalledWith({
        data: { baseUrl: "https://gateway.example.test", model: "", authToken: A_KEY },
      }),
    );
  });

  it.each(["保存", "测试连接"])("disables both actions while %s is pending", async (action) => {
    fns.fetchLlmSettings.mockResolvedValue(ok(anLlmView()));
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    fns.saveAnthropicSettingsFn.mockReturnValue(pending);
    fns.testAnthropicSettingsFn.mockReturnValue(pending);
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.click(within(card).getByRole("button", { name: action }));
    expect(within(card).getByRole("button", { name: "保存" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "测试连接" })).toBeDisabled();
    resolve(
      action === "保存" ? saved() : ok({ verdict: "verified", model: "probe", latencyMs: 12 }),
    );
    await waitFor(() => expect(within(card).getByRole("button", { name: "保存" })).toBeEnabled());
    expect(within(card).getByRole("button", { name: "测试连接" })).toBeEnabled();
  });

  it("cancelling removal preserves the current settings without a server call", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(anLlmView()));
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.click(within(card).getByRole("button", { name: "移除" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("移除后将停用 LLM 功能");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(fns.removeLlmSectionFn).not.toHaveBeenCalled();
    expect(card).toHaveTextContent("…AK01");
  });

  it("removing Anthropic asks first", async () => {
    fns.fetchLlmSettings.mockResolvedValue(ok(anLlmView()));
    fns.removeLlmSectionFn.mockResolvedValue(ok(llmNotConfigured()));
    const { user } = renderSection();
    const card = await screen.findByRole("region", { name: "Anthropic" });
    await user.click(within(card).getByRole("button", { name: "移除" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认移除" }));
    await waitFor(() =>
      expect(fns.removeLlmSectionFn).toHaveBeenCalledWith({ data: { section: "anthropic" } }),
    );
    expect(await screen.findByText("LLM 未配置")).toBeInTheDocument();
  });
});
