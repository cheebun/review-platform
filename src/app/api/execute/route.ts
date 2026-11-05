import { NextResponse } from "next/server";
import { ACCOUNT_HEADER, parseGithubAccount } from "@/lib/accounts";
import {
  createOctokit,
  fetchPullRequestMeta,
  mergePullRequest,
  submitPullRequestReview,
} from "@/lib/github";
import { parsePrUrl } from "@/lib/parse-pr-url";
import { shouldMergeAfterShip } from "@/lib/repos";
import { runReviewSession } from "@/lib/review-session";
import type { AiReviewResult, ExecuteMode, ExecuteResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const startReviewBefore = Date.now() + 90_000;
  try {
    const account = parseGithubAccount(request.headers.get(ACCOUNT_HEADER));
    const body = (await request.json()) as {
      url?: string;
      mode?: ExecuteMode;
      sessionId?: string;
    };
    if (!body.url?.trim()) {
      return NextResponse.json({ error: "请提供 PR URL" }, { status: 400 });
    }

    const mode: ExecuteMode =
      body.mode === "force_approve"
        ? "force_approve"
        : body.mode === "merge"
          ? "merge"
          : "ship";
    const ref = parsePrUrl(body.url);
    const octokit = createOctokit(account);

    if (mode === "merge") {
      const pr = await fetchPullRequestMeta(octokit, ref);
      const mergeResult = await mergePullRequest(octokit, ref, pr.sha);
      const merged = Boolean(mergeResult.merged);
      if (!merged) {
        return NextResponse.json(
          { error: "Merge 未成功（可能未满足合并条件）" },
          { status: 400 },
        );
      }

      const emptyReview: AiReviewResult = {
        summary: "",
        findings: [],
        verificationRequests: [],
      };

      const result: ExecuteResult = {
        mode,
        pr: {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          title: pr.title,
          author: pr.author,
          htmlUrl: pr.htmlUrl,
          base: pr.base,
          head: pr.head,
        },
        review: emptyReview,
        highestSeverity: null,
        approved: false,
        merged: true,
        githubEvent: "COMMENT",
        reviewCommentBody: "",
      };
      return NextResponse.json(result);
    }

    if (mode === "force_approve") {
      const pr = await fetchPullRequestMeta(octokit, ref);
      const reviewCommentBody = "Force approved.";
      const submitted = await submitPullRequestReview(
        octokit,
        ref,
        "APPROVE",
        undefined,
        pr.sha,
      );
      let merged = false;
      if (shouldMergeAfterShip(pr.author)) {
        const mergeResult = await mergePullRequest(octokit, ref, pr.sha);
        merged = Boolean(mergeResult.merged);
      }

      const emptyReview: AiReviewResult = {
        summary: "",
        findings: [],
        verificationRequests: [],
      };

      const result: ExecuteResult = {
        mode,
        pr: {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          title: pr.title,
          author: pr.author,
          htmlUrl: pr.htmlUrl,
          base: pr.base,
          head: pr.head,
        },
        review: emptyReview,
        highestSeverity: null,
        approved: true,
        merged,
        githubEvent: "APPROVE",
        reviewCommentBody,
        githubReviewId: submitted.id,
      };
      return NextResponse.json(result);
    }

    if (body.sessionId != null && typeof body.sessionId !== "string") {
      return NextResponse.json({ error: "审查会话 ID 无效" }, { status: 400 });
    }
    const session = await runReviewSession({ url: ref.url, account, sessionId: body.sessionId, startReviewBefore });
    return session.pending
      ? NextResponse.json(session, { status: 202 })
      : NextResponse.json(session.result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
