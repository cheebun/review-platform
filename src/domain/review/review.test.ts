import { describe, expect, it } from "vitest";
import {
  buildReviewCommentBody,
  buildReviewDiff,
  decideGithubEvent,
  highestSeverity,
  reviewCommentMarker,
  reviewVerdict,
  toAiReviewResult,
  MAX_COMMENT_BODY_CHARS,
} from "./review";
import type { AiReviewResult, Finding, Severity } from "./types";

const finding: Finding = { severity: "P0", title: "Crash", body: "Missing guard" };
const review = {
  summary: "Reviewed form validation",
  findings: [finding],
  verificationRequests: ["Test validation"],
};
const f = (severity: Severity, title = "T", body = "B"): Finding => ({ severity, title, body });
const result = (over: Partial<AiReviewResult> = {}): AiReviewResult => ({
  summary: "S",
  findings: [],
  verificationRequests: ["V"],
  ...over,
});

const parse = (input: unknown) => toAiReviewResult(input);
const okValue = (input: unknown) => {
  const r = parse(input);
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.error)}`);
  return r.value;
};
const isValidation = (input: unknown) => {
  const r = parse(input);
  return !r.ok && r.error.kind === "validation";
};

describe("toAiReviewResult (ported from tests/review-ai.test.ts)", () => {
  it("decodes gateway JSON arrays while preserving blockers", () => {
    expect(okValue({ ...review, findings: JSON.stringify([finding]) }).findings).toEqual([finding]);
    expect(okValue({ ...review, findings: "[]" }).findings).toEqual([]);
  });

  it.each([
    ['[{"severity":"P0","body":"unescaped "quote""}]'],
    ["null"],
    ["{}"],
    [JSON.stringify([{ severity: "P0" }])],
  ])("rejects malformed findings string %s", (findings) => {
    expect(isValidation({ ...review, findings })).toBe(true);
  });
});

describe("toAiReviewResult: fail closed", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["string", "ok"],
    ["number", 1],
    ["array", []],
  ])("non-object input (%s)", (_n, v) => {
    expect(isValidation(v)).toBe(true);
  });

  it.each([
    ["empty object (the legacy test's `{}`)", {}],
    ["missing summary", { findings: [] }],
    ["blank summary", { ...review, summary: "  " }],
    ["numeric summary", { ...review, summary: 3 }],
    ["missing findings", { summary: "s" }],
    ["null findings", { summary: "s", findings: null }],
    ["findings object", { summary: "s", findings: {} }],
    [
      "one invalid finding among valid ones",
      { summary: "s", findings: [finding, { severity: "P0" }] },
    ],
    ["finding is null", { summary: "s", findings: [null] }],
    ["finding is a string", { summary: "s", findings: ["P0"] }],
    ["unknown severity", { summary: "s", findings: [{ ...finding, severity: "P9" }] }],
    ["blocker severity", { summary: "s", findings: [{ ...finding, severity: "critical" }] }],
    ["missing severity", { summary: "s", findings: [{ title: "t", body: "b" }] }],
    ["numeric severity", { summary: "s", findings: [{ ...finding, severity: 0 }] }],
    ["blank title", { summary: "s", findings: [{ ...finding, title: " " }] }],
    ["blank body", { summary: "s", findings: [{ ...finding, body: "" }] }],
    ["non-string title", { summary: "s", findings: [{ ...finding, title: 1 }] }],
    ["non-string path", { summary: "s", findings: [{ ...finding, path: 1 }] }],
    ["NaN line", { summary: "s", findings: [{ ...finding, line: Number.NaN }] }],
    ["string line", { summary: "s", findings: [{ ...finding, line: "3" }] }],
    ["verificationRequests not an array", { ...review, verificationRequests: "x" }],
    ["verificationRequests with a non-string", { ...review, verificationRequests: [1] }],
  ])("%s -> validation error, never a default approval", (_n, input) => {
    expect(isValidation(input)).toBe(true);
  });

  it("never throws, whatever the input", () => {
    const hostile = [
      {
        get summary(): string {
          throw new Error("boom");
        },
      },
      Object.create(null),
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    ];
    for (const h of hostile) expect(() => parse(h)).not.toThrow();
  });
});

describe("toAiReviewResult: normalisation", () => {
  it.each([
    ["p0", "P0"],
    [" P1 ", "P1"],
    ["p2", "P2"],
    ["NIT", "Nit"],
    ["nit", "Nit"],
    ["Nit", "Nit"],
  ])("severity %j is read as %s", (raw, expected) => {
    expect(
      okValue({ ...review, findings: [{ ...finding, severity: raw }] }).findings[0].severity,
    ).toBe(expected);
  });

  it("trims text and keeps optional fields only when non-empty", () => {
    const out = okValue({
      summary: "  s  ",
      summaryZh: "  ",
      findings: [
        {
          severity: "P1",
          title: " t ",
          body: " b ",
          titleZh: " tz ",
          bodyZh: "",
          path: " src/a.ts ",
          line: 12,
          extra: "dropped",
        },
      ],
      verificationRequests: [" v ", " ", "w"],
      verificationRequestsZh: ["z"],
    });
    expect(out.summary).toBe("s");
    expect(out.summaryZh).toBeUndefined();
    expect(out.findings[0]).toEqual({
      severity: "P1",
      title: "t",
      body: "b",
      titleZh: "tz",
      path: "src/a.ts",
      line: 12,
    });
    expect(out.verificationRequests).toEqual(["v", "w"]);
    expect(out.verificationRequestsZh).toEqual(["z"]);
  });

  it("accepts null for optional fields", () => {
    const out = okValue({
      ...review,
      summaryZh: null,
      verificationRequests: null,
      findings: [{ ...finding, titleZh: null, bodyZh: null, path: null, line: null }],
    });
    expect(out.findings[0]).toEqual(finding);
  });

  it("fills default verification requests when none are given (empty findings stay empty)", () => {
    const out = okValue({ summary: "s", findings: [] });
    expect(out.findings).toEqual([]);
    expect(out.verificationRequests).toHaveLength(2);
    expect(out.verificationRequestsZh).toHaveLength(2);
  });

  it("an empty findings list approves", () => {
    expect(decideGithubEvent(okValue({ summary: "s", findings: [] }).findings)).toBe("APPROVE");
  });
});

describe("highestSeverity", () => {
  it("is null for no findings", () => {
    expect(highestSeverity([])).toBeNull();
  });
  it.each([
    [["Nit"], "Nit"],
    [["Nit", "P2"], "P2"],
    [["P2", "P1", "Nit"], "P1"],
    [["Nit", "P1", "P0", "P2"], "P0"],
    [["P1", "P1"], "P1"],
  ] as [Severity[], Severity][])("%j -> %s", (sev, expected) => {
    expect(highestSeverity(sev.map((s) => f(s)))).toBe(expected);
  });
  it("ignores unknown runtime severities and does not throw", () => {
    expect(highestSeverity([{ ...f("P2"), severity: "weird" as Severity }])).toBeNull();
  });
});

describe("decideGithubEvent", () => {
  it("approves with no findings", () => {
    expect(decideGithubEvent([])).toBe("APPROVE");
  });
  it.each([["P1"], ["P2"], ["Nit"]] as [Severity][])("approves with only %s", (s) => {
    expect(decideGithubEvent([f(s)])).toBe("APPROVE");
  });
  it("requests changes on any P0", () => {
    expect(decideGithubEvent([f("Nit"), f("P0")])).toBe("REQUEST_CHANGES");
  });
  it.each(["p0", "P9", "", "critical", " P1"])(
    "fails closed on unknown runtime severity %j",
    (severity) => {
      expect(decideGithubEvent([{ ...f("P1"), severity: severity as Severity }])).toBe(
        "REQUEST_CHANGES",
      );
    },
  );
});

describe("reviewVerdict", () => {
  it.each([
    [[], "pass"],
    [[f("P1"), f("P2"), f("Nit")], "pass"],
    [[f("Nit"), f("P0")], "changes_requested"],
    [[{ ...f("P1"), severity: "critical" as Severity }], "changes_requested"],
  ] as [Finding[], string][])("%j -> %s", (findings, verdict) => {
    expect(reviewVerdict(findings)).toBe(verdict);
  });
  it("always agrees with decideGithubEvent", () => {
    for (const s of ["P0", "P1", "P2", "Nit", "p0", ""] as Severity[]) {
      const fs = [f(s)];
      expect(reviewVerdict(fs) === "pass").toBe(decideGithubEvent(fs) === "APPROVE");
    }
  });
});

describe("buildReviewCommentBody", () => {
  it("renders every section in order and a numbered list", () => {
    const body = buildReviewCommentBody(
      result({
        summary: "Sum",
        findings: [
          f("P0", "A", "a"),
          { ...f("P2", "B", "b"), path: "x.ts", line: 3 },
          { ...f("P1", "C", "c"), path: "y.ts" },
        ],
        verificationRequests: ["one", "two"],
      }),
    );
    expect(body).toBe(
      [
        "## Summary",
        "",
        "Sum",
        "",
        "## 🔴 P0 (Blockers)",
        "",
        "- **A**: a",
        "",
        "## 🟠 P1 (High)",
        "",
        "- **C** (`y.ts`): c",
        "",
        "## 🟡 P2 (Medium)",
        "",
        "- **B** (`x.ts:3`): b",
        "",
        "## 🔵 Nit",
        "",
        "- None.",
        "",
        "## Verification Requests",
        "",
        "1. one",
        "2. two",
      ].join("\n"),
    );
  });

  it("falls back to a default verification request", () => {
    expect(buildReviewCommentBody(result({ verificationRequests: [] }))).toContain(
      "1. Verify the changed critical user paths still work as expected.",
    );
  });

  it("empty findings -> four 'None.' sections", () => {
    const body = buildReviewCommentBody(result());
    expect(body.match(/- None\./g)).toHaveLength(4);
  });
});

describe("buildReviewCommentBody: dedupe marker", () => {
  const key = "a".repeat(64);
  it("builds a marker only for safe keys", () => {
    expect(reviewCommentMarker(key)).toEqual({ ok: true, value: `<!-- review:${key} -->` });
    for (const bad of ["", "x y", "a-->b", "<!--", "a\nb", "é", "a".repeat(129)]) {
      const r = reviewCommentMarker(bad);
      expect(r.ok).toBe(false);
    }
  });

  it("appends the marker last, separated by a blank line", () => {
    const body = buildReviewCommentBody(result(), { dedupeKey: key });
    expect(body.endsWith(`\n\n<!-- review:${key} -->`)).toBe(true);
    expect(body.split(`<!-- review:${key} -->`)).toHaveLength(2);
  });

  it("an invalid dedupe key is ignored by omission: no marker, never an injected one", () => {
    const body = buildReviewCommentBody(result(), { dedupeKey: "a-->b" });
    expect(body).not.toContain("<!-- review:");
  });
});

describe("buildReviewCommentBody: markdown injection (documented neutralisation)", () => {
  const key = "b".repeat(64);
  const marker = `<!-- review:${key} -->`;

  it("a finding that embeds the marker cannot forge a dedupe hit", () => {
    const evil = result({
      summary: `x ${marker}`,
      findings: [f("P0", marker, `body ${marker} <!-- review:${key} --> end`)],
      verificationRequests: [marker],
    });
    expect(buildReviewCommentBody(evil)).not.toContain(marker);
    expect(buildReviewCommentBody(evil)).not.toContain("<!--");
    const withMarker = buildReviewCommentBody(evil, { dedupeKey: key });
    expect(withMarker.split(marker)).toHaveLength(2);
  });

  it("neutralises @mentions (adds a zero-width space) but not emails", () => {
    const body = buildReviewCommentBody(
      result({
        summary: "ping @octocat and @org/team, mail a@b.com",
        findings: [f("P1", "@all", "cc @x")],
      }),
    );
    expect(body).not.toMatch(/(^|[^A-Za-z0-9])@[A-Za-z0-9]/);
    expect(body).toContain("@​octocat");
    expect(body).toContain("a@b.com");
  });

  it("collapses newlines in titles and verification items so they cannot forge headings or bullets", () => {
    const body = buildReviewCommentBody(
      result({
        findings: [f("P1", "t\n## 🔴 P0 (Blockers)\n- None.", "ok")],
        verificationRequests: ["a\n2. forged"],
      }),
    );
    expect(body.match(/^## 🔴 P0/gm)).toHaveLength(1);
    expect(body).not.toMatch(/^2\. forged/m);
  });

  it("escapes line-leading headings inside multi-line bodies", () => {
    const body = buildReviewCommentBody(
      result({ findings: [f("P1", "t", "first\n## Summary\n  # deeper")] }),
    );
    expect(body.match(/^## Summary$/gm)).toHaveLength(1);
    expect(body).toContain("\\## Summary");
    expect(body).toContain("\\# deeper");
  });

  it("closes unbalanced code fences so later sections still render", () => {
    const body = buildReviewCommentBody(result({ findings: [f("P1", "t", "x\n```js\nopen")] }));
    const fences = body.split("\n").filter((l) => /^\s*```/.test(l));
    expect(fences.length % 2).toBe(0);
  });

  it("strips backticks from the path so it cannot escape its code span", () => {
    const body = buildReviewCommentBody(
      result({ findings: [{ ...f("P1"), path: "a`**b**`.ts", line: 1 }] }),
    );
    expect(body).toContain("(`a'**b**'.ts:1`)");
  });
});

describe("buildReviewCommentBody: huge input", () => {
  it("stays below the GitHub comment limit, keeps P0 first, and keeps the marker", () => {
    const key = "c".repeat(64);
    const huge = "x".repeat(500_000);
    const findings = [
      f("P0", "blocker", huge),
      ...Array.from({ length: 50 }, (_, i) => f("Nit", `nit${i}`, huge)),
    ];
    const body = buildReviewCommentBody(
      result({ summary: huge, findings, verificationRequests: [huge] }),
      {
        dedupeKey: key,
      },
    );
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_BODY_CHARS + 100);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("**blocker**");
    expect(body.endsWith(`<!-- review:${key} -->`)).toBe(true);
  });

  it("many findings are truncated with a notice, P0 items survive", () => {
    const findings = [
      ...Array.from({ length: 5000 }, (_, i) => f("Nit", `n${i}`, "y".repeat(400))),
      f("P0", "late-blocker"),
    ];
    const body = buildReviewCommentBody(result({ findings }));
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("late-blocker");
    expect(body).toContain("truncated");
  });

  it("does not split a surrogate pair at the cut", () => {
    const body = buildReviewCommentBody(result({ findings: [f("P0", "t", "🎉".repeat(100_000))] }));
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("does not throw on odd runtime shapes (total)", () => {
    expect(() =>
      buildReviewCommentBody({
        summary: 1,
        findings: [null, { severity: "P0" }],
        verificationRequests: [2],
      } as never),
    ).not.toThrow();
  });
});

describe("buildReviewDiff (ported from tests/review-input.test.ts)", () => {
  it("large PRs send all files together without a character cap", () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      header: `### src/file${index}.ts (added, +1/-0)`,
      patch: `@@ -0,0 +1 @@\n+file${index}:${"x".repeat(250_000)}`,
    }));
    const diff = buildReviewDiff(files);
    expect(diff.length).toBeGreaterThan(1_000_000);
    for (const file of files) {
      expect(diff.includes(`${file.header}\n\`\`\`diff\n${file.patch}\n\`\`\`\n`)).toBe(true);
    }
  });

  it("long lines and Unicode remain intact in the complete Diff", () => {
    const patch = `@@ -0,0 +1 @@\n+${"🎉".repeat(200_000)}\n+last-line`;
    expect(buildReviewDiff([{ header: "### src/large.ts", patch }])).toBe(
      `### src/large.ts\n\`\`\`diff\n${patch}\n\`\`\`\n`,
    );
    expect(buildReviewDiff([])).toBe("");
  });
});
