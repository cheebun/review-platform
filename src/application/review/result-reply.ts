/**
 * The result reply in the review thread (FR-SLACK-08). Pure. Model-written text is reduced to
 * single-line, length-capped finding titles with Slack control characters escaped, so the reply
 * can never mention anyone, forge a link, or carry the raw model output (AC 4).
 */
import { reviewVerdict } from "../../domain/review/review";
import type { ApproveCheckpoint, Finding, ReviewFailureCategory } from "../../domain/review/types";
import type { ReviewJob } from "../../domain/review-queue/types";

const MAX_TITLE = 120;
const MAX_TITLES = 5;
const SEVERITIES = ["P0", "P1", "P2", "Nit"] as const;

/** Slack mrkdwn escaping: `&`, `<`, `>` are the only control characters. */
export const escapeSlack = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function cap(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

const short = (sha: string) => sha.slice(0, 7);

const SKIP_TEXT: Record<string, string> = {
  sha_changed: "head moved since the review, re-review needed",
  own_pr: "this is the connected account's own PR, self-approval is not possible",
  already_approved: "already approved at this commit",
  repo_not_allowed: "repository is not in the repo list",
  pr_merged: "PR is already merged",
  pr_closed: "PR is closed",
  pr_draft: "PR is a draft",
  not_passed: "the review did not pass",
};

const FAILURE_TEXT: Record<string, string> & Record<ReviewFailureCategory, string> = {
  interrupted: "the review was interrupted too many times",
  upstream: "GitHub or the model is unavailable",
  validation: "the PR or the model output could not be read",
  not_configured: "the reviewer is not configured (see /settings)",
  internal: "internal error",
};

export function approveLine(a: ApproveCheckpoint | undefined): string | null {
  if (!a) return null;
  switch (a.step) {
    case "approved":
      return `Auto-approve: approved at \`${short(a.sha)}\`.`;
    case "approve_skipped":
      return `Auto-approve: skipped (${SKIP_TEXT[a.reason] ?? "a gate did not hold"}).`;
    case "approve_failed":
      return "Auto-approve: failed. Reply `approve` to retry.";
    case "approve_pending":
      return null;
  }
}

function findingsLines(findings: readonly Finding[]): string[] {
  const counts = SEVERITIES.map((s) => `${s} ${findings.filter((f) => f.severity === s).length}`);
  const titles = findings
    .filter((f) => f.severity === "P0" || f.severity === "P1")
    .slice(0, MAX_TITLES)
    .map((f) => `• ${f.severity}: ${escapeSlack(cap(oneLine(f.title), MAX_TITLE))}`);
  return [`Findings: ${counts.join(" · ")}`, ...titles];
}

export type ReplyPr = {
  prUrl: string;
  /** The `review_result` id of this run, for the detail link. */
  recordId: string | null;
  /** The record's generic failure category, when this PR's run failed. */
  failure?: string | null;
};

/** One section per PR; a job that failed says why, from the category only (S4). */
export function renderResultReply(
  job: ReviewJob,
  prs: readonly ReplyPr[],
  link: (recordId: string) => string,
): string {
  const sections = prs.map(({ prUrl, recordId, failure }) => {
    const p = job.progress[prUrl] ?? {};
    const lines = [`<${escapeSlack(prUrl)}>`];
    if (job.state === "done" && p.review) {
      const verdict = reviewVerdict(p.review.findings);
      lines.push(
        verdict === "pass"
          ? ":large_green_circle: APPROVE (no blocking findings)"
          : ":red_circle: REQUEST_CHANGES (blocking findings)",
      );
      lines.push(...findingsLines(p.review.findings));
      const approve = approveLine(p.approve);
      if (approve) lines.push(approve);
      if (verdict === "pass") lines.push("Reply `merge` in this thread to merge.");
      else lines.push("Reply `force approve` to approve anyway, or `updated` after new commits.");
    } else {
      lines.push(`review failed: ${FAILURE_TEXT[failure ?? "internal"] ?? FAILURE_TEXT.internal}`);
    }
    if (recordId) lines.push(`Details: ${link(recordId)}`);
    return lines.join("\n");
  });
  return sections.join("\n\n");
}
