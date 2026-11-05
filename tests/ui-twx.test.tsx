import assert from "node:assert/strict";
import { test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { twx } from "../src/ui/twx";

test("twx merges conflicting classes so the call-site className wins", () => {
  const Box = twx("div")(() => "w-5 p-2");
  const html = renderToStaticMarkup(<Box className="w-6" />);
  const cls = /class="([^"]*)"/.exec(html)?.[1] ?? "";
  const tokens = cls.split(/\s+/);
  assert.ok(tokens.includes("w-6"), html);
  assert.ok(tokens.includes("p-2"), html);
  assert.ok(!tokens.includes("w-5"), html);
});
