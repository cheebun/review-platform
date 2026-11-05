import { describe, expect, it } from "vitest";
import { safeRedirect } from "./-safe-redirect";

describe("safeRedirect", () => {
  it.each([
    ["/", "/"],
    ["/review", "/review"],
    ["/review?x=1&y=2", "/review?x=1&y=2"],
    ["/a/b#frag", "/a/b#frag"],
    ["/foo:bar", "/foo:bar"],
    ["/a%20b", "/a%20b"],
  ])("accepts same-origin path %s", (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });

  it.each([
    "//evil.com",
    "//evil.com/x",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "https://evil.com",
    "http://evil.com/",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,x",
    "evil.com",
    "",
    " /ok",
    "/\t/evil.com",
    "/\n/evil.com",
    "/%2Fevil.com",
    "/%2fevil.com",
    "/%5Cevil.com",
    "/%5cevil.com",
    "%2F%2Fevil.com",
    "/%252Fevil.com",
    "/%255Cevil.com",
    "/%09/evil.com",
    "/%0a/evil.com",
    "/%zz",
    "/a\\b",
    "/\u0000x",
  ])("rejects %j and falls back to /", (input) => {
    expect(safeRedirect(input)).toBe("/");
  });

  it.each([undefined, null, 5, {}, ["/x"]])("non-string %j falls back to /", (input) => {
    expect(safeRedirect(input)).toBe("/");
  });
});
