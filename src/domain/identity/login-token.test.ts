import { describe, expect, it } from "vitest";
import { MIN_LOGIN_TOKEN_LENGTH, validateLoginTokenInput } from "./login-token";

describe("validateLoginTokenInput", () => {
  it("requires at least 6 characters", () => {
    expect(MIN_LOGIN_TOKEN_LENGTH).toBe(6);
  });

  it.each([6, 7, 32, 257, 10_000])("accepts %i characters (no maximum)", (n) => {
    const token = "a".repeat(n);
    expect(validateLoginTokenInput(token)).toEqual({ ok: true, value: token });
  });

  it.each([0, 1, 5])("rejects %i characters", (n) => {
    expect(validateLoginTokenInput("a".repeat(n))).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "token" },
    });
  });

  it.each([
    ["leading space", ` ${"a".repeat(40)}`],
    ["trailing space", `${"a".repeat(40)} `],
    ["trailing newline", `${"a".repeat(40)}\n`],
    ["leading tab", `\t${"a".repeat(40)}`],
    ["only whitespace", " ".repeat(40)],
  ])("rejects surrounding whitespace (%s) instead of trimming it", (_name, token) => {
    expect(validateLoginTokenInput(token)).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "token" },
    });
  });

  it("accepts inner spaces (a passphrase)", () => {
    const token = "correct horse battery staple and more words";
    expect(validateLoginTokenInput(token)).toEqual({ ok: true, value: token });
  });

  it.each([undefined, null, 42, {}, ["a".repeat(40)]])("rejects a non-string (%o)", (input) => {
    expect(validateLoginTokenInput(input)).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "token" },
    });
  });
});
