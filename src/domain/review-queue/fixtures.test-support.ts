/** Shared fixtures for the review-queue tests. Test-only; never imported by production code. */
import { aReviewJobInState } from "../../testing/builders/review-job";
import type { PrCheckpoint, ReviewJob, ReviewResultSnapshot, UrlProgress } from "./types";

export const NOW = new Date("2026-01-01T00:10:00.000Z");
export const URL1 = "https://github.com/acme/app/pull/1";
export const URL2 = "https://github.com/acme/app/pull/2";
export const ms = (n: number) => new Date(NOW.getTime() + n);

export const pr = (number: number, sha = `sha-${number}`): PrCheckpoint => ({
  owner: "acme",
  repo: "app",
  number,
  title: `PR ${number}`,
  author: "dev",
  htmlUrl: `https://github.com/acme/app/pull/${number}`,
  base: "main",
  head: `feature-${number}`,
  sha,
  baseSha: `base-${number}`,
});

export const PASS: ReviewResultSnapshot = {
  summary: "looks good",
  findings: [{ severity: "P2", title: "naming", body: "rename x" }],
  verificationRequests: ["run it"],
};

export const RED: ReviewResultSnapshot = {
  summary: "crash",
  findings: [
    { severity: "Nit", title: "typo", body: "fix" },
    { severity: "P0", title: "null deref", body: "guard it", path: "a.ts", line: 3 },
  ],
  verificationRequests: [],
};

/** A URL that was reviewed and commented on, ready for the approve checkpoint. */
export const reviewed = (
  number: number,
  review: ReviewResultSnapshot,
  extra: Partial<UrlProgress> = {},
): UrlProgress => ({
  reviewed: true,
  commented: true,
  pr: pr(number),
  review,
  reviewSeq: number,
  ...extra,
});

export const running = (overrides: Partial<ReviewJob> = {}): ReviewJob =>
  aReviewJobInState("running", { urls: [URL1, URL2], ...overrides });
