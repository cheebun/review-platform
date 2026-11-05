import { describe, expect, it } from "vitest";
import { err, isErr, isOk, ok, type DomainError, type Result } from "./result";

describe("Result", () => {
  it("ok and err narrow correctly", () => {
    const a: Result<number> = ok(1);
    const e: DomainError = { kind: "conflict", reason: "x" };
    const b: Result<number> = err(e);
    expect(isOk(a) && a.value).toBe(1);
    expect(isErr(b) && b.error).toEqual(e);
    expect(isOk(b)).toBe(false);
  });
});
