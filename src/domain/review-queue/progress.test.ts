import { describe, expect, it } from "vitest";
import { parseReviewJobProgress } from "./progress";
import type { UrlProgress } from "./types";

const URL1 = "https://github.com/acme/app/pull/1";

const full: UrlProgress = {
  reviewed: true,
  commented: true,
  submitted: true,
  merged: false,
  replied: true,
  reacted: false,
  completed: true,
  pr: {
    owner: "acme",
    repo: "app",
    number: 1,
    title: "t",
    author: "a",
    htmlUrl: URL1,
    base: "main",
    head: "feat",
    sha: "abc",
    baseSha: "def",
  },
  review: {
    summary: "s",
    summaryZh: "z",
    findings: [{ severity: "P1", title: "t", body: "b", path: "a.ts", line: 3 }],
    verificationRequests: ["v"],
    verificationRequestsZh: ["vz"],
  },
  batchReview: {
    fingerprint: "fp",
    total: 2,
    results: [{ summary: "s", findings: [], verificationRequests: [] }],
  },
  commentId: 11,
  githubReviewId: 22,
  result: { any: "thing" },
};

describe("parseReviewJobProgress", () => {
  it("round-trips a full payload through JSON", () => {
    const raw = JSON.parse(JSON.stringify({ [URL1]: full }));
    const r = parseReviewJobProgress(raw);
    expect(r).toEqual({ ok: true, value: { [URL1]: full } });
  });

  it("accepts an empty record and an empty per-url progress", () => {
    expect(parseReviewJobProgress({})).toEqual({ ok: true, value: {} });
    expect(parseReviewJobProgress({ [URL1]: {} })).toEqual({ ok: true, value: { [URL1]: {} } });
  });

  it("rejects unknown extra fields (fail closed, no silent stripping of checkpoint data)", () => {
    const r = parseReviewJobProgress({ [URL1]: { reviewed: true, commentID: 5 } });
    expect(r.ok).toBe(false);
    const nested = parseReviewJobProgress({ [URL1]: { pr: { ...full.pr, extra: 1 } } });
    expect(nested.ok).toBe(false);
  });

  it.each([
    ["non-object root", "nope"],
    ["null root", null],
    ["array root", []],
    ["non-object url entry", { [URL1]: 3 }],
    ["string boolean", { [URL1]: { reviewed: "true" } }],
    ["string commentId", { [URL1]: { commentId: "5" } }],
    ["fractional commentId", { [URL1]: { commentId: 1.5 } }],
    ["negative githubReviewId", { [URL1]: { githubReviewId: -1 } }],
    [
      "bad severity",
      {
        [URL1]: {
          review: {
            summary: "s",
            findings: [{ severity: "P9", title: "t", body: "b" }],
            verificationRequests: [],
          },
        },
      },
    ],
    ["review without findings", { [URL1]: { review: { summary: "s", verificationRequests: [] } } }],
    ["pr missing sha", { [URL1]: { pr: { ...full.pr, sha: undefined } } }],
    [
      "batchReview wrong total type",
      { [URL1]: { batchReview: { fingerprint: "f", total: "2", results: [] } } },
    ],
  ])("rejects wrong types: %s", (_name, raw) => {
    const r = parseReviewJobProgress(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("validation");
  });
});
