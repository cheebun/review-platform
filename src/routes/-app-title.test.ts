import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Route as RootRoute } from "./__root";
import { Route as IndexRoute } from "./_authed/index";
import { Route as MergeRoute } from "./_authed/merge";
import { Route as ReviewDetailRoute } from "./_authed/review.$reviewId";
import { Route as ReviewListRoute } from "./_authed/review.index";
import { Route as SettingsRoute } from "./_authed/settings";

const APP_TITLE = "Review platform";

type HeadRoute = { options: { head?: unknown } };

function titleOf(route: HeadRoute): string | undefined {
  const head = route.options.head as () => { meta?: Array<{ title?: string }> };
  return head().meta?.find((m) => m.title !== undefined)?.title;
}

describe("app title", () => {
  it("the document title is exactly the product name", () => {
    expect(titleOf(RootRoute)).toBe(APP_TITLE);
  });

  it.each([
    ["Overview", IndexRoute],
    ["Review", ReviewListRoute],
    ["Review detail", ReviewDetailRoute],
    ["Merge", MergeRoute],
    ["Settings", SettingsRoute],
  ] as Array<[string, HeadRoute]>)(
    "the %s page title is '<page> · Review platform'",
    (page, route) => {
      expect(titleOf(route)).toBe(`${page} · ${APP_TITLE}`);
    },
  );

  it("the login and owner-setup page heading is the product name", () => {
    const source = readFileSync(new URL("./login.tsx", import.meta.url), "utf8");
    expect(source).toContain(`<Heading>${APP_TITLE}</Heading>`);
    expect(source).not.toContain("agent-ops");
  });
});
