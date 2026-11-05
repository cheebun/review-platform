import { expect, it } from "vitest";
import { redact } from "./redact";

it("redacts URLs and explicit secrets", () => {
  const out = redact("connect to pg://u:p@host:1/db failed; token=abc123", ["abc123"]);
  expect(out).not.toMatch(/pg:|u:p@|abc123/);
});
