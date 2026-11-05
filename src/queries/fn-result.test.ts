import { describe, expect, it } from "vitest";
import { FnRequestError, unwrapFnResult } from "./fn-result";

describe("unwrapFnResult", () => {
  it("returns the value on success", () => {
    expect(unwrapFnResult({ ok: true, value: 3 })).toBe(3);
  });

  it("throws an error that carries the kind and request id", () => {
    const run = () =>
      unwrapFnResult({
        ok: false,
        error: { kind: "rate_limited", message: "Too many requests.", requestId: "r-1" },
      });
    expect(run).toThrow(FnRequestError);
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({ kind: "rate_limited", requestId: "r-1" });
    }
  });
});
