import { describe, expect, it } from "vitest";
import { loginHref, setupRedirectHref } from "./-guard";

describe("setupRedirectHref (FR-AUTH-01)", () => {
  // [initialized, signedIn, expected]; null shows the wizard. The URL (any query) never matters.
  const table: Array<[boolean, boolean, string | null]> = [
    [false, false, null],
    [false, true, null],
    [true, false, "/login"],
    [true, true, "/"],
  ];

  it.each(table)("initialized=%s signedIn=%s → %s", (initialized, signedIn, expected) => {
    expect(setupRedirectHref({ initialized, signedIn })).toBe(expected);
  });

  it("never sends /setup back to /setup", () => {
    for (const [initialized, signedIn] of table) {
      expect(setupRedirectHref({ initialized, signedIn }) ?? "").not.toMatch(/^\/setup/);
    }
  });
});

describe("loginHref", () => {
  it("carries the requested page as an encoded redirect", () => {
    expect(loginHref("/review?x=1")).toBe("/login?redirect=%2Freview%3Fx%3D1");
  });
});
