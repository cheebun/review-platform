import { describe, expect, it } from "vitest";
import { parsePrUrl } from "./pr-ref";

const okRef = (input: string) => {
  const r = parsePrUrl(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${JSON.stringify(r.error)}`);
  return r.value;
};
const isValidation = (input: unknown) => {
  const r = parsePrUrl(input as string);
  return !r.ok && r.error.kind === "validation";
};

describe("parsePrUrl: valid", () => {
  it("parses a plain PR URL", () => {
    expect(okRef("https://github.com/bosinc/katana-web/pull/123")).toEqual({
      owner: "bosinc",
      repo: "katana-web",
      number: 123,
      url: "https://github.com/bosinc/katana-web/pull/123",
    });
  });

  it.each([
    "https://github.com/a/b/pull/7/",
    "https://github.com/a/b/pull/7/files",
    "https://github.com/a/b/pull/7/commits",
    "https://github.com/a/b/pull/7/checks",
    "https://github.com/a/b/pull/7?foo=bar",
    "https://github.com/a/b/pull/7/files?w=1",
    "https://github.com/a/b/pull/7#issuecomment-1",
    "https://github.com/a/b/pull/7/files#diff-abc",
    "http://github.com/a/b/pull/7",
    "HTTPS://GitHub.com/a/b/pull/7",
    "  https://github.com/a/b/pull/7  \n",
  ])("accepts %j and canonicalises", (input) => {
    expect(okRef(input)).toEqual({
      owner: "a",
      repo: "b",
      number: 7,
      url: "https://github.com/a/b/pull/7",
    });
  });

  it("keeps owner and repo casing, and allows . _ - in repo names", () => {
    expect(okRef("https://github.com/Foo-Bar/my.repo_name-1/pull/1")).toMatchObject({
      owner: "Foo-Bar",
      repo: "my.repo_name-1",
    });
  });
});

describe("parsePrUrl: rejected (validation error)", () => {
  it.each([
    ["other host", "https://gitlab.com/a/b/pull/1"],
    ["subdomain host", "https://www.github.com/a/b/pull/1"],
    ["host suffix", "https://github.com.evil.com/a/b/pull/1"],
    ["userinfo trick", "https://github.com@evil.com/a/b/pull/1"],
    ["other scheme", "ftp://github.com/a/b/pull/1"],
    ["issues not pull", "https://github.com/a/b/issues/1"],
    ["non-numeric PR number", "https://github.com/a/b/pull/abc"],
    ["mixed PR number", "https://github.com/a/b/pull/12abc"],
    ["number glued to suffix", "https://github.com/a/b/pull/12files"],
    ["negative number", "https://github.com/a/b/pull/-1"],
    ["zero", "https://github.com/a/b/pull/0"],
    ["unsafe integer", "https://github.com/a/b/pull/99999999999999999999"],
    ["leading zeros", "https://github.com/a/b/pull/007"],
    ["empty", ""],
    ["missing number", "https://github.com/a/b/pull/"],
    ["extra path segment", "https://github.com/a/b/pull/1/other"],
    ["owner leading hyphen", "https://github.com/-a/b/pull/1"],
    ["owner trailing hyphen", "https://github.com/a-/b/pull/1"],
    ["owner consecutive hyphens", "https://github.com/a--b/c/pull/1"],
    ["owner underscore", "https://github.com/a_b/c/pull/1"],
    ["owner dot", "https://github.com/a.b/c/pull/1"],
    ["owner 40 chars", `https://github.com/${"a".repeat(40)}/c/pull/1`],
    ["repo dot", "https://github.com/a/./pull/1"],
    ["repo dotdot", "https://github.com/a/../pull/1"],
    ["repo with space", "https://github.com/a/b c/pull/1"],
    ["repo with colon", "https://github.com/a/b:c/pull/1"],
    ["repo 101 chars", `https://github.com/a/${"b".repeat(101)}/pull/1`],
    ["percent-encoded repo", "https://github.com/a/b%2e%2e/pull/1"],
    ["percent-encoded slash", "https://github.com/a/b%2Fc/pull/1"],
    ["percent-encoded owner", "https://github.com/%61/b/pull/1"],
    ["percent-encoded pull", "https://github.com/a/b/%70ull/1"],
    ["percent-encoded number", "https://github.com/a/b/pull/%31"],
    ["backslash", "https://github.com/a\\b/c/pull/1"],
    ["newline in query", "https://github.com/a/b/pull/1?x\ny"],
    ["unicode owner", "https://github.com/ａ/b/pull/1"],
    ["fullwidth digits", "https://github.com/a/b/pull/１"],
  ])("%s", (_name, input) => {
    expect(isValidation(input)).toBe(true);
  });

  it("is total on non-string input", () => {
    for (const v of [undefined, null, 1, {}, [], Symbol.iterator]) {
      expect(isValidation(v)).toBe(true);
    }
  });

  it("accepts a 39-char owner and 100-char repo (boundary)", () => {
    expect(
      okRef(`https://github.com/${"a".repeat(39)}/${"b".repeat(100)}/pull/1`).owner,
    ).toHaveLength(39);
  });
});
