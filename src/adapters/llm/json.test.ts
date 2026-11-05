import { describe, expect, it } from "vitest";
import { parseJsonText } from "./json";

describe("parseJsonText", () => {
  it("parses a plain JSON object", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("unwraps a fenced block and drops prose around the object", () => {
    expect(parseJsonText('Here you go:\n```json\n{"a":[1,2]}\n```\nDone.')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
    expect(parseJsonText('result {"a":"b"} end')).toEqual({ ok: true, value: { a: "b" } });
  });

  it("returns a validation error, never throws, and never echoes the text", () => {
    for (const text of ["", "   ", "not json", '{"a":', "{unterminated secret-value"]) {
      const result = parseJsonText(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("validation");
        expect(JSON.stringify(result.error)).not.toContain("secret-value");
      }
    }
  });
});
