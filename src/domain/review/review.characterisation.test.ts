import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as legacy from "../../lib/review-ai";
import { buildReviewDiff as legacyBuildReviewDiff } from "../../lib/review-input";
import type { Finding as LegacyFinding, Severity as LegacySeverity } from "../../lib/types";
import * as next from "./review";
import type { Finding, Severity } from "./types";

const arbSev = fc.constantFrom<Severity>("P0", "P1", "P2", "Nit");
// Plain prose: no newlines, mentions, '#', '<', '`', '*', '-->' or markers.
const prose = fc
  .stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,:;!?()]{0,40}$/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const arbFinding: fc.Arbitrary<Finding> = fc.record(
  {
    severity: arbSev,
    title: prose,
    body: prose,
    path: fc.stringMatching(/^[a-z]{1,8}(\/[a-z]{1,8}){0,2}\.ts$/),
    line: fc.integer({ min: 1, max: 5000 }),
  },
  { requiredKeys: ["severity", "title", "body"] },
);
const arbFindings = fc.array(arbFinding, { maxLength: 8 });
const arbReview = fc.record({
  summary: prose,
  findings: arbFindings,
  verificationRequests: fc.array(prose, { maxLength: 3 }),
});

describe("review: old src/lib vs new domain", () => {
  it("highestSeverity agrees", () => {
    fc.assert(
      fc.property(
        arbFindings,
        (f) => next.highestSeverity(f) === legacy.highestSeverity(f as LegacyFinding[]),
      ),
    );
  });

  it("decideGithubEvent agrees on every known severity", () => {
    fc.assert(
      fc.property(
        arbFindings,
        (f) => next.decideGithubEvent(f) === legacy.decideGithubEvent(f as LegacyFinding[]),
      ),
    );
  });

  it("buildReviewCommentBody agrees on plain-text reviews (no marker)", () => {
    fc.assert(
      fc.property(
        arbReview,
        (r) => next.buildReviewCommentBody(r) === legacy.buildReviewCommentBody(r),
      ),
      {
        numRuns: 500,
      },
    );
  });

  it("buildReviewCommentBody + dedupeKey equals the legacy body with the marker appended as ship-pr.ts does", () => {
    const key = "f".repeat(64);
    fc.assert(
      fc.property(
        arbReview,
        (r) =>
          next.buildReviewCommentBody(r, { dedupeKey: key }) ===
          `${legacy.buildReviewCommentBody(r)}\n\n<!-- review:${key} -->`,
      ),
      { numRuns: 200 },
    );
  });

  it("toAiReviewResult agrees on valid output, including JSON-string findings", () => {
    fc.assert(
      fc.property(arbReview, fc.boolean(), (r, asString) => {
        const raw = {
          ...r,
          summaryZh: "z",
          findings: asString ? JSON.stringify(r.findings) : r.findings,
        };
        const old = legacy.toAiReviewResult(raw);
        const out = next.toAiReviewResult(raw);
        return out.ok && JSON.stringify(out.value) === JSON.stringify(old);
      }),
      { numRuns: 300 },
    );
  });

  it("toAiReviewResult rejects exactly what the legacy version threw on (structural cases)", () => {
    const review = { summary: "s", findings: [], verificationRequests: ["v"] };
    const bad: unknown[] = [
      null,
      undefined,
      1,
      "x",
      {},
      { summary: "s" },
      { findings: [] },
      { ...review, summary: " " },
      { ...review, findings: "null" },
      { ...review, findings: "{}" },
      { ...review, findings: "[bad" },
      { ...review, findings: [{ severity: "P9", title: "t", body: "b" }] },
      { ...review, findings: [{ severity: "P0", title: "", body: "b" }] },
      { ...review, findings: [{ severity: "P0" }] },
      { ...review, findings: [null] },
    ];
    for (const b of bad) {
      expect(() => legacy.toAiReviewResult(b), JSON.stringify(b)).toThrow();
      const r = next.toAiReviewResult(b);
      expect(r.ok, JSON.stringify(b)).toBe(false);
    }
  });

  it("buildReviewDiff agrees", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ header: fc.string(), patch: fc.string() }), { maxLength: 5 }),
        (files) => next.buildReviewDiff(files) === legacyBuildReviewDiff(files),
      ),
    );
  });
});

describe("review: intentional deviations from src/lib", () => {
  it("legacy decideGithubEvent approved an unknown severity; the new one requests changes", () => {
    const f = [{ severity: "critical" as LegacySeverity, title: "t", body: "b" }];
    expect(legacy.decideGithubEvent(f)).toBe("APPROVE");
    expect(next.decideGithubEvent(f as Finding[])).toBe("REQUEST_CHANGES");
  });

  it("legacy coerced a non-string optional field with String(); the new one fails closed", () => {
    const raw = { summary: "s", findings: [{ severity: "P1", title: "t", body: "b", titleZh: 5 }] };
    expect(legacy.toAiReviewResult(raw).findings[0].titleZh).toBe("5");
    expect(next.toAiReviewResult(raw).ok).toBe(false);
  });

  it("legacy silently dropped a malformed `line`; the new one fails closed", () => {
    const raw = { summary: "s", findings: [{ severity: "P1", title: "t", body: "b", line: "3" }] };
    expect(legacy.toAiReviewResult(raw).findings[0].line).toBeUndefined();
    expect(next.toAiReviewResult(raw).ok).toBe(false);
  });

  it("legacy rendered raw model text; the new one neutralises markers, mentions and forged headings", () => {
    const r = {
      summary: "s",
      findings: [{ severity: "P1" as const, title: "t", body: "cc @bob <!-- x -->\n## Summary" }],
      verificationRequests: ["v"],
    };
    const old = legacy.buildReviewCommentBody(r);
    const out = next.buildReviewCommentBody(r);
    expect(old).toContain("<!-- x -->");
    expect(old).toContain("@bob");
    expect(out).not.toContain("<!--");
    expect(out).toContain("@​bob");
    expect(old.match(/^## Summary$/gm)).toHaveLength(2);
    expect(out.match(/^## Summary$/gm)).toHaveLength(1);
  });

  it("legacy comment bodies were unbounded; the new one is capped below the GitHub limit", () => {
    const r = {
      summary: "s",
      findings: [{ severity: "P1" as const, title: "t", body: "x".repeat(200_000) }],
      verificationRequests: ["v"],
    };
    expect(legacy.buildReviewCommentBody(r).length).toBeGreaterThan(65_536);
    expect(next.buildReviewCommentBody(r).length).toBeLessThan(65_536);
  });
});
