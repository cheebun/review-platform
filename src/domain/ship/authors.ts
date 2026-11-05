/**
 * Review author list and labels moved from src/lib/repos.ts (FR-REVIEW-01/02). The no-merge list,
 * `shouldMergeAfterShip` and the Slack `review_list` scope are gone: merging is a separate owner
 * action (FR-SHIP-05) and anyone may trigger a review.
 */

export const DEFAULT_OPEN_PR_OWNER = "bosinc";
export const DEFAULT_OPEN_PR_REPO = "katana-web";

/** Own GitHub login: list actions are Copy + Merge instead of Ship. */
export const OWN_REVIEW_AUTHOR = "zhiyong-eng" as const;

export function isOwnReviewAuthor(author: string): boolean {
  return author.toLowerCase() === OWN_REVIEW_AUTHOR.toLowerCase();
}

/** Clipboard text for announcing own PRs (URL + title only). */
export function buildOwnPrCopyText(htmlUrl: string, title: string): string {
  return `${htmlUrl}\n${title}`;
}

/** Authors whose open PRs appear in the review list. */
export const REVIEW_AUTHORS = [
  "Yujiaqi-1m",
  "cicihuangext-stack",
  "jaycechenex",
  "lijun1m",
  "tian-1m",
  "tiancheng-1m",
  "zhengzhu-1m",
  "zuodajiang-1m",
  "zhiyong-eng",
] as const;

export type ReviewAuthor = (typeof REVIEW_AUTHORS)[number];

/** Short labels for the author filter chips. */
export const REVIEW_AUTHOR_LABELS: Record<ReviewAuthor, string> = {
  "Yujiaqi-1m": "Jiaqi",
  "cicihuangext-stack": "Cici",
  jaycechenex: "Jayce",
  lijun1m: "Jun",
  "tian-1m": "Tianye",
  "tiancheng-1m": "Tiancheng",
  "zhengzhu-1m": "Zhengzhu",
  "zuodajiang-1m": "Dajiang",
  "zhiyong-eng": "Zhiyong",
};

/** Exact, case-sensitive type guard (as in repos.ts). */
export function isReviewAuthor(login: string): login is ReviewAuthor {
  return (REVIEW_AUTHORS as readonly string[]).includes(login);
}
