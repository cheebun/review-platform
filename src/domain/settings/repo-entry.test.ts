import { describe, expect, it } from "vitest";
import { MAX_REPOS, checkRepoAddable, parseRepoEntry, repoKey, type RepoEntry } from "./repo-entry";

const entry = (canonical: string): RepoEntry => {
  const [owner, repo] = canonical.split("/");
  return { owner, repo, canonical };
};

describe("parseRepoEntry", () => {
  it.each([
    ["acme/web", { owner: "acme", repo: "web", canonical: "acme/web" }],
    ["  Acme/Web.v2  ", { owner: "Acme", repo: "Web.v2", canonical: "Acme/Web.v2" }],
    ["my-org/a_b-c.d", { owner: "my-org", repo: "a_b-c.d", canonical: "my-org/a_b-c.d" }],
    ["\tA1/b\n", { owner: "A1", repo: "b", canonical: "A1/b" }],
  ])("accepts %j (trimmed, case kept)", (input, expected) => {
    expect(parseRepoEntry(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    "foo/bar/baz",
    "foo",
    " /bar",
    "foo/ba r",
    "",
    "   ",
    "/bar",
    "foo/",
    "fo_o/bar",
    "foo.bar/baz",
    "foo/bär",
    "https://github.com/foo/bar",
  ])("rejects %j on format, as validation (FR-GITHUB-07 AC2)", (input) => {
    const result = parseRepoEntry(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: "validation", field: "repo" });
      // The message never echoes the input.
      if (input.trim()) expect(JSON.stringify(result.error)).not.toContain(input.trim());
    }
  });

  it.each([undefined, null, 42, {}, ["a/b"]])("rejects a non-string %j", (input) => {
    expect(parseRepoEntry(input)).toMatchObject({ ok: false, error: { kind: "validation" } });
  });

  it("rejects an entry longer than 200 characters before matching", () => {
    expect(parseRepoEntry(`a/${"b".repeat(200)}`)).toMatchObject({ ok: false });
  });
});

describe("repoKey", () => {
  it("is the lower-cased canonical name", () => {
    expect(repoKey("Acme/Web")).toBe("acme/web");
  });
});

describe("checkRepoAddable", () => {
  it("allows a new entry", () => {
    expect(checkRepoAddable(entry("acme/web"), [entry("acme/api")])).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("rejects a case-insensitive duplicate (FR-GITHUB-07 AC1)", () => {
    expect(checkRepoAddable(entry("Foo/Bar"), [entry("foo/bar")])).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "repo" },
    });
  });

  it("rejects once the list holds MAX_REPOS entries, and allows one below", () => {
    expect(MAX_REPOS).toBe(50);
    const full = Array.from({ length: MAX_REPOS }, (_, i) => entry(`o/r${i}`));
    expect(checkRepoAddable(entry("o/new"), full)).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
    expect(checkRepoAddable(entry("o/new"), full.slice(1)).ok).toBe(true);
  });

  it("reports the duplicate before the limit", () => {
    const full = Array.from({ length: MAX_REPOS }, (_, i) => entry(`o/r${i}`));
    const result = checkRepoAddable(entry("O/R3"), full);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "validation") {
      expect(result.error.message).toMatch(/already/i);
    }
  });
});
