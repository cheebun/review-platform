export type Severity = "P0" | "P1" | "P2" | "Nit";

export type Finding = {
  severity: Severity;
  title: string;
  body: string;
  /** Chinese copy for the local UI modal. */
  titleZh?: string;
  bodyZh?: string;
  path?: string;
  line?: number;
};

export type AiReviewResult = {
  summary: string;
  /** Chinese summary for the local UI modal. */
  summaryZh?: string;
  findings: Finding[];
  verificationRequests: string[];
  /** Chinese verification items for the local UI modal. */
  verificationRequestsZh?: string[];
};

export type PrRef = {
  owner: string;
  repo: string;
  number: number;
  url: string;
};

export type ExecuteMode = "ship" | "force_approve" | "merge";

export type ExecuteResult = {
  mode: ExecuteMode;
  pr: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    author: string;
    htmlUrl: string;
    base: string;
    head: string;
  };
  review: AiReviewResult;
  highestSeverity: Severity | null;
  approved: boolean;
  merged: boolean;
  githubEvent: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  reviewCommentBody: string;
  githubReviewId?: number;
};

export type OpenPrItem = {
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  draft: boolean;
  updatedAt: string;
  base: string;
  head: string;
  /** True when GitHub reviewDecision is APPROVED. */
  approved: boolean;
};
