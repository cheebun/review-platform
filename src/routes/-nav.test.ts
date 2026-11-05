import { describe, expect, it } from "vitest";
import { NAV_BOTTOM, NAV_MAIN, isNavItemActive, navLinks } from "./-nav";

describe("navigation (§2.7)", () => {
  it("main: a flat list of Overview, Review, Merge", () => {
    expect(NAV_MAIN).toEqual([
      { label: "Overview", to: "/" },
      { label: "Review", to: "/review" },
      { label: "Merge", to: "/merge" },
    ]);
  });

  it("bottom: Settings", () => {
    expect(NAV_BOTTOM).toEqual([{ label: "Settings", to: "/settings" }]);
  });

  it("every entry is a link; no group headers", () => {
    for (const entry of [...NAV_MAIN, ...NAV_BOTTOM]) {
      expect(Object.keys(entry).toSorted()).toEqual(["label", "to"]);
    }
  });

  it("navLinks lists every link in display order; all are in-app paths", () => {
    expect(navLinks().map((i) => i.to)).toEqual(["/", "/review", "/merge", "/settings"]);
    for (const item of navLinks()) expect(item.to.startsWith("/")).toBe(true);
    expect(navLinks().map((i) => i.label)).not.toContain("Daily UI tweaks");
  });
});

describe("isNavItemActive", () => {
  it.each([
    ["/", "/", true],
    ["/", "/merge", false],
    ["/merge", "/merge", true],
    ["/merge", "/merge/anything", true],
    ["/merge", "/mergeish", false],
    ["/review", "/review/r-1", true],
  ])("%s on %s → %s", (to, pathname, active) => {
    expect(isNavItemActive({ label: "x", to }, pathname)).toBe(active);
  });
});
