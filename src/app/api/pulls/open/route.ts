import { NextResponse } from "next/server";
import { ACCOUNT_HEADER, parseGithubAccount } from "@/lib/accounts";
import { createOctokit, listOpenPullRequests } from "@/lib/github";
import {
  DEFAULT_OPEN_PR_OWNER,
  DEFAULT_OPEN_PR_REPO,
  REVIEW_AUTHORS,
} from "@/lib/repos";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const account = parseGithubAccount(request.headers.get(ACCOUNT_HEADER));
    const octokit = createOctokit(account);
    const items = await listOpenPullRequests(
      octokit,
      DEFAULT_OPEN_PR_OWNER,
      DEFAULT_OPEN_PR_REPO,
      REVIEW_AUTHORS,
    );

    return NextResponse.json({
      owner: DEFAULT_OPEN_PR_OWNER,
      repo: DEFAULT_OPEN_PR_REPO,
      authors: REVIEW_AUTHORS,
      items,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
