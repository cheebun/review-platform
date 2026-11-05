import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePrUrl as legacyParsePrUrl } from "../../lib/parse-pr-url";
import { parsePrUrl } from "./pr-ref";

// alnum words joined by single hyphens: valid by construction.
const arbOwner = fc
  .array(fc.stringMatching(/^[A-Za-z0-9]{1,6}$/), { minLength: 1, maxLength: 3 })
  .map((words) => words.join("-"));
const arbRepo = fc.stringMatching(/^[A-Za-z0-9._-]{1,30}$/).filter((r) => r !== "." && r !== "..");
const arbNumber = fc.integer({ min: 1, max: 2_000_000_000 });
const arbSuffix = fc.constantFrom("", "/", "/files", "/commits", "/checks");
const arbTail = fc.constantFrom("", "?a=1", "#frag", "?x#y", "#a/b");
const arbScheme = fc.constantFrom("https", "http", "HTTPS");
const arbHost = fc.constantFrom("github.com", "GitHub.com", "GITHUB.COM");

describe("parsePrUrl: old src/lib vs new domain", () => {
  it("agrees on every well-formed URL", () => {
    fc.assert(
      fc.property(
        arbScheme,
        arbHost,
        arbOwner,
        arbRepo,
        arbNumber,
        arbSuffix,
        arbTail,
        (sc, h, o, r, n, s, t) => {
          const input = `${sc}://${h}/${o}/${r}/pull/${n}${s}${t}`;
          const legacy = legacyParsePrUrl(input);
          const next = parsePrUrl(input);
          return next.ok && JSON.stringify(next.value) === JSON.stringify(legacy);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("the new parser only accepts what the legacy parser accepted, with the same fields", () => {
    const piece = fc.constantFrom(
      "https://",
      "http://",
      "github.com",
      "/",
      "a",
      "b-",
      "-b",
      "pull",
      "12",
      "007",
      "files",
      "?",
      "#",
      "%2e",
      "..",
      ".",
      " ",
      "\n",
      "x_y",
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 14 }), (parts) => {
        const input = parts.join("");
        const next = parsePrUrl(input);
        if (!next.ok) return true;
        let legacy;
        try {
          legacy = legacyParsePrUrl(input);
        } catch {
          return false; // new accepted something old rejected
        }
        return (
          legacy.owner === next.value.owner &&
          legacy.repo === next.value.repo &&
          legacy.number === next.value.number
        );
      }),
      { numRuns: 5000 },
    );
  });

  it("legacy throws where the new one returns a validation error", () => {
    for (const bad of ["", "https://example.com/a/b/pull/1", "https://github.com/a/b/pull/x"]) {
      expect(() => legacyParsePrUrl(bad)).toThrow();
      const r = parsePrUrl(bad);
      expect(!r.ok && r.error.kind).toBe("validation");
    }
  });

  // Intentional deviations: each of these URLs was accepted by the legacy regex.
  it.each([
    ["number glued to a suffix", "https://github.com/a/b/pull/12files"],
    ["PR number zero", "https://github.com/a/b/pull/0"],
    [
      "leading zeros (legacy kept `007` in the url but number 7)",
      "https://github.com/a/b/pull/007",
    ],
    ["unsafe integer (legacy lost precision)", "https://github.com/a/b/pull/99999999999999999999"],
    ["owner with consecutive hyphens", "https://github.com/a--b/c/pull/1"],
    ["owner with an underscore", "https://github.com/a_b/c/pull/1"],
    ["repo `..`", "https://github.com/a/../pull/1"],
    ["percent-encoded repo", "https://github.com/a/b%2e%2e/pull/1"],
    ["repo with a space", "https://github.com/a/b c/pull/1"],
    ["owner over 39 chars", `https://github.com/${"a".repeat(40)}/c/pull/1`],
  ])("deviation (stricter): %s", (_n, input) => {
    expect(() => legacyParsePrUrl(input)).not.toThrow();
    expect(parsePrUrl(input).ok).toBe(false);
  });
});
