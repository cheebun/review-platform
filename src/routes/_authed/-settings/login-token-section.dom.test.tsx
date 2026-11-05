import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LoginTokenFnResult } from "../../../functions/login-token.logic";
import { LoginTokenSection, type RotateClient } from "./login-token-section";

const CURRENT = "old pass phrase";
const NEXT = "new pass phrase";

function failure(kind: string, extra: Record<string, unknown> = {}): LoginTokenFnResult {
  return {
    ok: false,
    error: { kind, message: "RAW server text", requestId: "r1", ...extra } as never,
  };
}

function setup(rotate?: RotateClient["rotate"]) {
  const client: RotateClient = {
    rotate: vi.fn<RotateClient["rotate"]>(rotate ?? (async () => ({ ok: true, value: null }))),
  };
  const afterRotate = vi.fn();
  render(<LoginTokenSection client={client} afterRotate={afterRotate} />);
  return { client, afterRotate, user: userEvent.setup() };
}

const currentInput = () => screen.getByLabelText("当前登录令牌");
const nextInput = () => screen.getByLabelText("新登录令牌");
const confirmInput = () => screen.getByLabelText("再次输入新登录令牌");
const submitButton = () => screen.getByRole("button", { name: "更换登录令牌" });

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  entries: { current?: string; token?: string; confirm?: string } = {},
) {
  const { current = CURRENT, token = NEXT } = entries;
  const confirm = entries.confirm ?? token;
  if (current) await user.type(currentInput(), current);
  if (token) await user.type(nextInput(), token);
  if (confirm) await user.type(confirmInput(), confirm);
  await user.click(submitButton());
}

describe("LoginTokenSection (FR-AUTH-07)", () => {
  it("is a titled section with three password fields", () => {
    setup();
    expect(screen.getByRole("heading", { level: 2, name: "登录令牌" })).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(currentInput()).toHaveAttribute("type", "password");
    expect(currentInput()).toHaveAttribute("autocomplete", "current-password");
    for (const input of [nextInput(), confirmInput()]) {
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveAttribute("autocomplete", "new-password");
    }
    expect(screen.getByText(/所有会话/)).toBeInTheDocument();
  });

  it("is a POST form whose submit is handled in JS, never a native GET", () => {
    setup();
    const form = currentInput().closest("form")!;
    expect(form).toHaveAttribute("method", "post");
    expect(form).not.toHaveAttribute("action");
    expect(fireEvent.submit(form)).toBe(false);
  });

  it("empty: inline errors, no request", async () => {
    const { client, user } = setup();
    await user.click(submitButton());
    expect(await screen.findByText("请输入当前登录令牌")).toBeInTheDocument();
    expect(screen.getByText("请输入登录令牌")).toBeInTheDocument();
    expect(screen.getByText("请再次输入登录令牌")).toBeInTheDocument();
    expect(client.rotate).not.toHaveBeenCalled();
  });

  it("the new token follows the token rules, checked before any request", async () => {
    const { client, user } = setup();
    await fill(user, { token: "abc" });
    const message = await screen.findByText("登录令牌至少 6 个字符");
    expect(nextInput()).toHaveAttribute("aria-invalid", "true");
    expect(nextInput()).toHaveAttribute("aria-describedby", message.id);
    expect(client.rotate).not.toHaveBeenCalled();
  });

  it("entries that differ: the error shows on the confirm field", async () => {
    const { client, user } = setup();
    await fill(user, { confirm: `${NEXT}x` });
    const message = await screen.findByText("两次输入的登录令牌不一致");
    expect(confirmInput()).toHaveAttribute("aria-describedby", message.id);
    expect(client.rotate).not.toHaveBeenCalled();
  });

  it("success: sends the entries verbatim, then goes to /login", async () => {
    const { client, afterRotate, user } = setup();
    await fill(user, { current: ` ${CURRENT}` });
    await waitFor(() => expect(afterRotate).toHaveBeenCalledTimes(1));
    expect(client.rotate).toHaveBeenCalledWith({
      current: ` ${CURRENT}`,
      token: NEXT,
      confirm: NEXT,
    });
  });

  it("a 400 on current shows inline on the current field", async () => {
    const { afterRotate, user } = setup(async () =>
      failure("validation", { field: "current", fieldMessage: "Current token is incorrect." }),
    );
    await fill(user);
    const message = await screen.findByText("当前登录令牌错误");
    expect(currentInput()).toHaveAttribute("aria-invalid", "true");
    expect(currentInput()).toHaveAttribute("aria-describedby", message.id);
    expect(screen.queryByText("Current token is incorrect.")).toBeNull();
    expect(afterRotate).not.toHaveBeenCalled();
  });

  it("a 400 on the new token shows inline on that field", async () => {
    const { user } = setup(async () => failure("validation", { field: "token" }));
    await fill(user);
    const message = await screen.findByText("登录令牌不符合要求");
    expect(nextInput()).toHaveAttribute("aria-describedby", message.id);
  });

  it("429: says when to try again", async () => {
    const { afterRotate, user } = setup(async () =>
      failure("rate_limited", { retryAfterSeconds: 120 }),
    );
    await fill(user);
    expect(await screen.findByText("尝试次数过多，请 2 分钟后再试。")).toBeInTheDocument();
    expect(afterRotate).not.toHaveBeenCalled();
  });

  it.each([
    ["an unexpected error kind", async () => failure("internal")],
    [
      "a thrown request",
      async (): Promise<LoginTokenFnResult> => {
        throw new Error("network");
      },
    ],
  ])("%s shows a generic message, never the server text", async (_name, rotate) => {
    const { user } = setup(rotate);
    await fill(user);
    expect(await screen.findByText("更换失败，请稍后重试。")).toBeInTheDocument();
    expect(screen.queryByText("RAW server text")).toBeNull();
  });

  it("a double submit while pending sends one request", async () => {
    let resolve!: (r: LoginTokenFnResult) => void;
    const { client, user } = setup(() => new Promise((r) => (resolve = r)));
    await user.type(currentInput(), CURRENT);
    await user.type(nextInput(), NEXT);
    await user.type(confirmInput(), NEXT);
    const form = currentInput().closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(client.rotate).toHaveBeenCalledTimes(1));
    resolve({ ok: true, value: null });
  });
});
