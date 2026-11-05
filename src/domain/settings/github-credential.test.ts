import { describe, expect, it } from "vitest";
import {
  MAX_TOKEN_LENGTH,
  MIN_TOKEN_LENGTH,
  githubAvailability,
  parseTokenInput,
  toTokenDisplay,
  type CredentialMeta,
} from "./github-credential";

const SENTINEL = "github_pat_SENTINEL0123456789abcdefWXYZ";

describe("parseTokenInput", () => {
  it("accepts a token and trims surrounding whitespace (a pasted newline)", () => {
    expect(parseTokenInput(`  ${SENTINEL}\n`)).toEqual({ ok: true, value: SENTINEL });
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["inner whitespace", "ghp_abc def0123456789"],
    ["too short", "a".repeat(MIN_TOKEN_LENGTH - 1)],
    ["too long", "a".repeat(MAX_TOKEN_LENGTH + 1)],
    ["non-string", 12345],
    ["non-printable", `ghp_${"a".repeat(20)}\u0000`],
  ])("rejects %s as validation, never echoing it", (_name, input) => {
    const result = parseTokenInput(input);
    expect(result).toMatchObject({ ok: false, error: { kind: "validation", field: "token" } });
    if (typeof input === "string" && input.trim()) {
      expect(JSON.stringify(result)).not.toContain(input.trim());
    }
  });

  it("accepts exactly the length bounds", () => {
    expect(parseTokenInput("a".repeat(MIN_TOKEN_LENGTH)).ok).toBe(true);
    expect(parseTokenInput("a".repeat(MAX_TOKEN_LENGTH)).ok).toBe(true);
    expect(MAX_TOKEN_LENGTH).toBe(255);
  });
});

const meta: CredentialMeta = {
  login: "octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/1",
  last4: "WXYZ",
  savedAt: new Date("2026-11-04T01:02:03Z"),
  savedByUserId: "u1",
  tokenKind: "fine_grained",
  scopes: null,
  version: 3,
};

describe("toTokenDisplay", () => {
  it("exposes only the display fields, with an ISO time", () => {
    expect(toTokenDisplay(meta)).toEqual({
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      last4: "WXYZ",
      savedAt: "2026-11-04T01:02:03.000Z",
      tokenKind: "fine_grained",
      scopes: null,
    });
  });

  it("drops any extra field it is handed (e.g. ciphertext)", () => {
    const leaky = { ...meta, ciphertext: SENTINEL } as CredentialMeta;
    expect(JSON.stringify(toTokenDisplay(leaky))).not.toContain(SENTINEL);
  });
});

describe("githubAvailability", () => {
  it("no row → not_configured", () => {
    expect(githubAvailability(null)).toEqual({ state: "not_configured" });
  });

  it("a row that does not decrypt → needs_reset, keeping the display", () => {
    expect(githubAvailability({ meta, decrypts: false })).toEqual({
      state: "needs_reset",
      login: "octocat",
    });
  });

  it("a row that decrypts → ready", () => {
    expect(githubAvailability({ meta, decrypts: true })).toEqual({
      state: "ready",
      login: "octocat",
    });
  });
});
