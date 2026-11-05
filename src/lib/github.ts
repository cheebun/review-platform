import { Octokit } from "@octokit/rest";
import { resolveGithubToken, type GithubAccount } from "./accounts";
import type { OpenPrItem, PrRef } from "./types";
import type { ReviewDiffFile } from "./review-input";
import { recoverFileDiff } from "./github-diff";

export function createOctokit(account: GithubAccount) {
  return new Octokit({ auth: resolveGithubToken(account) });
}

export async function listOpenPullRequests(
  octokit: Octokit,
  owner: string,
  repo: string,
  authors: readonly string[],
  maxAgeDays = 15,
): Promise<OpenPrItem[]> {
  const allow = new Set(authors.map((name) => name.toLowerCase()));
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const data = await octokit.paginate(octokit.pulls.list, {
    owner,
    repo,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });

  const items = data
    .filter((pr) => {
      if (pr.draft) return false;
      if (!allow.has((pr.user?.login ?? "").toLowerCase())) return false;
      const updatedAt = Date.parse(pr.updated_at);
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) return false;
      return true;
    })
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "unknown",
      htmlUrl: pr.html_url,
      draft: false,
      updatedAt: pr.updated_at,
      base: pr.base.ref,
      head: pr.head.ref,
      approved: false,
    }));

  const approvedNumbers = await fetchApprovedPullNumbers(
    octokit,
    owner,
    repo,
    items.map((item) => item.number),
  );

  return items.map((item) => ({
    ...item,
    approved: approvedNumbers.has(item.number),
  }));
}

/** Batch-fetch GitHub reviewDecision; returns PR numbers that are APPROVED. */
async function fetchApprovedPullNumbers(
  octokit: Octokit,
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Set<number>> {
  const approved = new Set<number>();
  if (numbers.length === 0) return approved;

  const chunkSize = 40;
  for (let i = 0; i < numbers.length; i += chunkSize) {
    const chunk = numbers.slice(i, i + chunkSize);
    const fields = chunk
      .map((number, index) => `p${index}: pullRequest(number: ${number}) { number reviewDecision }`)
      .join("\n");

    const result = await octokit.graphql<{
      repository: Record<string, { number: number; reviewDecision: string | null } | null> | null;
    }>(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          ${fields}
        }
      }`,
      { owner, repo },
    );

    const nodes = result.repository ?? {};
    for (const node of Object.values(nodes)) {
      if (node?.reviewDecision === "APPROVED") {
        approved.add(node.number);
      }
    }
  }

  return approved;
}

export async function fetchPullRequestMeta(octokit: Octokit, ref: PrRef) {
  const { data: pr } = await octokit.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
  });

  return {
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? "unknown",
    base: pr.base.ref,
    head: pr.head.ref,
    sha: pr.head.sha,
    baseSha: pr.base.sha,
    state: pr.state,
    merged: pr.merged,
    changedFiles: pr.changed_files,
    htmlUrl: pr.html_url,
    draft: pr.draft ?? false,
  };
}

export async function fetchPullRequest(octokit: Octokit, ref: PrRef) {
  const meta = await fetchPullRequestMeta(octokit, ref);

  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    per_page: 100,
  });

  let complete = files.length === meta.changedFiles;
  const diffFiles: ReviewDiffFile[] = [];
  const missingPatches: string[] = [];
  let mergeBase: Promise<string> | undefined;
  const getMergeBase = () =>
    (mergeBase ??= octokit.repos
      .compareCommits({
        owner: ref.owner,
        repo: ref.repo,
        base: meta.baseSha,
        head: meta.sha,
        per_page: 1,
      })
      .then(({ data }) => {
        const sha = data.merge_base_commit.sha;
        if (!sha) throw new Error("无法确定 PR 的共同祖先提交");
        return sha;
      }));
  for (const file of files) {
    let header = `### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
    if (file.previous_filename) header += `\nPrevious path: ${file.previous_filename}`;
    if (file.patch) {
      diffFiles.push({ header, patch: file.patch });
    } else {
      try {
        diffFiles.push(await recoverFileDiff(octokit, ref, file, header, getMergeBase));
      } catch (error) {
        complete = false;
        const reason = error instanceof Error ? error.message : "无法恢复 Diff";
        missingPatches.push(`${file.filename}（${reason}）`);
      }
    }
  }

  const current = await fetchPullRequestMeta(octokit, ref);
  if (current.sha !== meta.sha || current.baseSha !== meta.baseSha) {
    throw new Error("PR 在读取 Diff 时发生更新，请重新 Review。");
  }

  return {
    ...meta,
    diffFiles,
    complete,
    incompleteReason:
      files.length !== meta.changedFiles
        ? `文件列表不完整（收到 ${files.length}/${meta.changedFiles} 个文件）`
        : missingPatches.length
          ? `以下文件缺少 Diff：${missingPatches.join("、")}`
          : undefined,
  };
}

/** Visible Conversation comment on the PR (issues API). */
export async function createPullRequestComment(octokit: Octokit, ref: PrRef, body: string) {
  const { data } = await octokit.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
    body,
  });
  return data;
}

export async function submitPullRequestReview(
  octokit: Octokit,
  ref: PrRef,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body?: string,
  commitId?: string,
) {
  // GitHub requires a body for REQUEST_CHANGES / COMMENT. Prefer no visible tip:
  // details already live in the Conversation comment.
  const resolvedBody = body?.trim() || (event === "APPROVE" ? undefined : "<!-- -->");

  const { data } = await octokit.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    event,
    ...(commitId ? { commit_id: commitId } : {}),
    ...(resolvedBody != null ? { body: resolvedBody } : {}),
  });
  return data;
}

export async function mergePullRequest(octokit: Octokit, ref: PrRef, sha?: string) {
  const { data } = await octokit.pulls.merge({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    merge_method: "merge",
    ...(sha ? { sha } : {}),
  });
  return data;
}
