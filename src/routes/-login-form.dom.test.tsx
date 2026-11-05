import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LoginTokenFnResult } from "../functions/login-token.logic";
import { LoginForm, type LoginClient } from "./-login-form";

const TOKEN = "correct horse battery";

function failure(kind: string, extra: Record<string, unknown> = {}): LoginTokenFnResult {
  return {
    ok: false,
    error: { kind, message: "RAW server text", requestId: "r1", ...extra } as never,
  };
}

function setup(login?: LoginClient["login"]) {
  const client: LoginClient = {
    login: vi.fn<LoginClient["login"]>(login ?? (async () => ({ ok: true, value: null }))),
  };
  const onSuccess = vi.fn();
  const onNotInitialized = vi.fn();
  render(<LoginForm client={client} onSuccess={onSuccess} onNotInitialized={onNotInitialized} />);
  return { client, onSuccess, onNotInitialized, user: userEvent.setup() };
}

const tokenInput = () => screen.getByLabelText("登录令牌");

async function submit(user: ReturnType<typeof userEvent.setup>, token = TOKEN) {
  await user.type(tokenInput(), token);
  await user.click(screen.getByRole("button", { name: "登录" }));
}

describe("LoginForm", () => {
  it("has one token field: a password input for the current password", () => {
    setup();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    const input = tokenInput();
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(input).toHaveAttribute("name", "token");
    expect(screen.queryByLabelText(/邮箱|密码/)).toBeNull();
  });

  it("is a POST form whose submit is handled in JS, never a native GET", () => {
    setup();
    const form = tokenInput().closest("form")!;
    expect(form).toHaveAttribute("method", "post");
    expect(form).not.toHaveAttribute("action");
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.submit(form)).toBe(false);
  });

  it("sends the token verbatim (no trimming) and reports success", async () => {
    const { client, onSuccess, user } = setup();
    await submit(user, ` ${TOKEN} `);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(client.login).toHaveBeenCalledWith(` ${TOKEN} `);
  });

  it("asks for a token when empty, without a request", async () => {
    const { client, user } = setup();
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("请输入登录令牌")).toBeInTheDocument();
    expect(tokenInput()).toHaveAttribute("aria-invalid", "true");
    expect(client.login).not.toHaveBeenCalled();
  });

  it("does not apply the token rules at login (no hints)", async () => {
    const { client, user } = setup(async () => failure("unauthenticated"));
    await submit(user, "abc");
    await waitFor(() => expect(client.login).toHaveBeenCalledWith("abc"));
  });

  it("shows 'wrong token' for unauthenticated, never the server text", async () => {
    const { onSuccess, user } = setup(async () => failure("unauthenticated"));
    await submit(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("登录令牌错误");
    expect(alert).not.toHaveTextContent("RAW");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("shows the lockout with the wait in minutes", async () => {
    const { user } = setup(async () => failure("rate_limited", { retryAfterSeconds: 61 }));
    await submit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("尝试次数过多，请 2 分钟后再试。");
  });

  it("goes to setup when the system is not initialized", async () => {
    const { onNotInitialized, onSuccess, user } = setup(async () =>
      failure("not_found", { kind: "not_found" }),
    );
    await submit(user);
    await waitFor(() => expect(onNotInitialized).toHaveBeenCalledTimes(1));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ["an internal error", async () => failure("internal")],
    [
      "a thrown call",
      async () => {
        throw new Error("network down");
      },
    ],
  ])("shows a generic alert for %s", async (_name, login) => {
    const { user } = setup(login as LoginClient["login"]);
    await submit(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("登录失败，请稍后重试。");
    expect(alert).not.toHaveTextContent("network");
  });

  it("sends one request for a double submit while pending", async () => {
    let release!: () => void;
    const { client, user } = setup(
      () =>
        new Promise<LoginTokenFnResult>((resolve) => {
          release = () => resolve({ ok: true, value: null });
        }),
    );
    await user.type(tokenInput(), TOKEN);
    const form = tokenInput().closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(client.login).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /登录/ })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: /登录/ })).toBeEnabled());
    expect(client.login).toHaveBeenCalledTimes(1);
  });
});
