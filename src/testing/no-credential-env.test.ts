import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guard (migration-plan.md stage 4, 4c): Jira and LLM credentials come from `SettingsStore`, so
 * tests inject them through the settings-store fake and never read `JIRA_*`, `ANTHROPIC_*` or
 * `OPENAI_*` from the environment. Only a file listed below may do so, with its reason.
 */
const ALLOWED: Record<string, string> = {
  // Legacy src/lib/review-ai.ts reads env directly; this test sets fake values and restores them.
  // Both are deleted by stage 5b.
  "tests/review-ai.test.ts": "legacy src/lib (stage 5b)",
};

const NS = ["ANTHROPIC", "OPENAI", "JIRA"].join("|");
// `process.env.X_`, `process.env["X_`, and `const { X_... } = process.env`.
const READS = [
  new RegExp(String.raw`process\.env(?:\.|\[\s*["'\x60])(?:${NS})_`),
  new RegExp(String.raw`\{[^}]*\b(?:${NS})_\w*[^}]*\}\s*=\s*process\.env\b`),
];

const reads = (source: string) => READS.some((re) => re.test(source));

/** Test files, contracts, fakes, harnesses and setup files: everything a test run loads for tests. */
function testFiles(): string[] {
  const files = new Set([
    ...globSync("{src,tests}/**/*.{test,contract}.{ts,tsx}"),
    ...globSync("src/testing/**/*.{ts,tsx}"),
    ...globSync("vitest.config.ts"),
  ]);
  return [...files].map((f) => f.replaceAll("\\", "/")).toSorted();
}

describe("no Jira or LLM credentials from env in tests", () => {
  it("the scanner detects every read form and ignores look-alikes", () => {
    // Built at run time so this file does not match its own scan.
    const p = ["process", "env"].join(".");
    for (const s of [
      `${p}.ANTHROPIC_API_KEY`,
      `${p}["OPENAI_API_KEY"]`,
      `${p}['JIRA_EMAIL']`,
      `const { JIRA_API_TOKEN } = ${p};`,
    ])
      expect(reads(s), s).toBe(true);
    for (const s of [
      `${p}.TEST_DATABASE_URL`,
      `${p}[name]`,
      `vi.stubEnv("ANTHROPIC_BASE_URL", x)`,
      `// ${p} ANTHROPIC_BASE_URL is never read`,
    ])
      expect(reads(s), s).toBe(false);
  });

  it("scans the test tree (sanity: the glob is not empty)", () => {
    const files = testFiles();
    expect(files).toContain("vitest.config.ts");
    expect(files).toContain("src/testing/integration/global-setup.ts");
    expect(files.length).toBeGreaterThan(50);
  });

  it("no test file outside the allow-list reads JIRA_*, ANTHROPIC_* or OPENAI_* from env", () => {
    const offenders = testFiles().filter((f) => !(f in ALLOWED) && reads(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every allow-listed file still exists (drop the entry when it is deleted)", () => {
    const files = new Set(testFiles());
    for (const f of Object.keys(ALLOWED)) expect(files.has(f), f).toBe(true);
  });
});
