import { http, HttpResponse } from "msw";
import type { GithubWorld, PrRead, WorldPr } from "./world";

export const FAKE_GITHUB_BASE_URL = "https://github-api.test";

const json = (body: unknown, init: ResponseInit = {}) => HttpResponse.json(body as object, init);
const notFound = () => json({ message: "Not Found" }, { status: 404 });

function restPr(pr: WorldPr, world: GithubWorld, read?: PrRead) {
  return {
    ...(read ? { mergeable: read.mergeable, mergeable_state: read.mergeableState } : {}),
    number: pr.number,
    title: pr.title,
    body: pr.body === "" ? null : pr.body,
    user: { login: pr.author },
    base: { ref: pr.base, sha: pr.baseSha },
    head: { ref: pr.head, sha: pr.headSha },
    html_url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    draft: pr.draft,
    state: pr.state,
    merged: pr.merged,
    changed_files: pr.reportedChangedFiles ?? world.fileCount(pr),
    updated_at: pr.updatedAt,
  };
}

/** A stable numeric id per name, as GitHub repository objects carry one. */
function hashId(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function slicePage<T>(request: Request, items: T[]) {
  const url = new URL(request.url);
  const perPage = Number(url.searchParams.get("per_page") ?? 30);
  const current = Number(url.searchParams.get("page") ?? 1);
  const slice = items.slice((current - 1) * perPage, current * perPage);
  const headers: Record<string, string> = {};
  if (current * perPage < items.length) {
    url.searchParams.set("page", String(current + 1));
    headers.link = `<${url.toString()}>; rel="next"`;
  }
  return { slice, headers };
}

function page<T>(request: Request, items: T[]) {
  const { slice, headers } = slicePage(request, items);
  return json(slice, { headers });
}

/** Pages a namespaced list response such as `{ total_count, check_runs: [...] }`. */
function pageOf<T>(request: Request, key: string, items: T[]) {
  const { slice, headers } = slicePage(request, items);
  return json({ total_count: items.length, [key]: slice }, { headers });
}

/** msw handlers emulating the GitHub REST and GraphQL endpoints the adapter uses. */
export function githubHandlers(world: GithubWorld, baseUrl = FAKE_GITHUB_BASE_URL) {
  return [
    http.all(`${baseUrl}/*`, async ({ request }) => {
      const url = new URL(request.url);
      const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = request.method;
      world.record(`${method} ${url.pathname}`);

      const fault = world.takeFault();
      if (fault?.kind === "rate_limited") {
        return json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: {
              "retry-after": String(fault.retryAfterSec),
              "x-ratelimit-remaining": "0",
            },
          },
        );
      }
      if (fault?.kind === "bad_gateway") return json({ message: "Bad Gateway" }, { status: 502 });
      if (fault?.kind === "forbidden") return json({ message: "Forbidden" }, { status: 403 });
      if (fault?.kind === "unauthorized") {
        return json({ message: "Bad credentials" }, { status: 401 });
      }

      if (method === "GET" && path.join("/") === "user") return json({ login: world.login });
      if (method === "GET" && path.join("/") === "user/repos") {
        return page(
          request,
          world.listAccessibleRepos().map((r) => ({
            id: hashId(r.fullName),
            full_name: r.fullName,
            name: r.fullName.split("/")[1],
            owner: { login: r.fullName.split("/")[0] },
            private: r.private,
            archived: r.archived,
            permissions: {
              admin: false,
              maintain: false,
              push: r.canPush,
              triage: true,
              pull: true,
            },
          })),
        );
      }

      if (method === "POST" && path.join("/") === "graphql") {
        const { query, variables } = (await request.json()) as {
          query: string;
          variables: { owner: string; repo: string };
        };
        const repository: Record<string, unknown> = {};
        for (const m of query.matchAll(/(p\d+):\s*pullRequest\(number:\s*(\d+)\)/g)) {
          const pr = world.getPr({
            owner: variables.owner,
            repo: variables.repo,
            number: Number(m[2]),
          });
          repository[m[1]] = pr ? { number: pr.number, reviewDecision: pr.reviewDecision } : null;
        }
        return json({ data: { repository } });
      }

      if (path[0] === "repos" && path.length === 3 && method === "GET") {
        const flags = world.mergeSettings({ owner: path[1], repo: path[2] });
        return json({
          full_name: `${path[1]}/${path[2]}`,
          allow_merge_commit: flags.merge,
          allow_squash_merge: flags.squash,
          allow_rebase_merge: flags.rebase,
        });
      }
      if (path[0] !== "repos" || path.length < 4) return notFound();
      const [, owner, repo, kind, rest, sub] = path;

      if (kind === "commits" && rest !== undefined && method === "GET") {
        if (sub === "check-runs") {
          const latest = (url.searchParams.get("filter") ?? "latest") === "latest";
          return pageOf(request, "check_runs", world.listCheckRuns({ owner, repo }, rest, latest));
        }
        if (sub === "statuses") {
          return page(request, world.listCommitStatuses({ owner, repo }, rest));
        }
      }

      if (kind === "pulls" && rest === undefined && method === "GET") {
        return page(
          request,
          world.listPrs(owner, repo).map((pr) => restPr(pr, world)),
        );
      }
      if (kind === "compare" && method === "GET") {
        if (world.failMergeBase) return json({ message: "Server Error" }, { status: 500 });
        world.record("compare");
        return json({ merge_base_commit: { sha: world.mergeBase } });
      }
      if (kind === "contents" && method === "GET") {
        const filePath = path.slice(4).join("/");
        const sha = world.fileShaAtMergeBase(filePath);
        if (!sha) return notFound();
        world.record("content", filePath);
        return json({ type: "file", path: filePath, sha, encoding: "none", content: "" });
      }
      if (kind === "git" && rest === "blobs" && method === "GET") {
        world.record("blob", sub);
        if (world.failBlobs) return json({ message: "Server Error" }, { status: 500 });
        const bytes = world.blob(sub);
        if (!bytes) return notFound();
        const content = world.truncateBlobs ? bytes.subarray(0, 1) : bytes;
        return json({
          sha: sub,
          encoding: "base64",
          size: bytes.length,
          content: content.toString("base64"),
        });
      }

      const number = Number(rest);
      const ref = { owner, repo, number };
      if (!Number.isInteger(number)) return notFound();
      const pr = world.getPr(ref);
      if (!pr) return notFound();

      if (kind === "pulls" && sub === undefined && method === "GET") {
        return json(restPr(pr, world, world.readPr(ref)));
      }
      if (kind === "pulls" && sub === "files" && method === "GET") {
        return page(request, world.readFiles(ref));
      }
      if (kind === "issues" && sub === "comments") {
        if (method === "GET") return page(request, world.listComments(ref));
        if (method === "POST") {
          const { body } = (await request.json()) as { body: string };
          return json(world.addComment(ref, body), { status: 201 });
        }
      }
      if (kind === "pulls" && sub === "reviews") {
        if (method === "GET") {
          return page(
            request,
            world.listReviews(ref).map((r) => ({
              id: r.id,
              user: { login: r.user },
              body: r.body,
              state: r.state,
              commit_id: r.commitId,
            })),
          );
        }
        if (method === "POST") {
          const input = (await request.json()) as {
            event: string;
            body?: string;
            commit_id?: string;
          };
          const state =
            input.event === "APPROVE"
              ? "APPROVED"
              : input.event === "REQUEST_CHANGES"
                ? "CHANGES_REQUESTED"
                : "COMMENTED";
          const review = world.addReview(ref, {
            body: input.body,
            state,
            commitId: input.commit_id ?? pr.headSha,
          });
          return json({ id: review.id, state }, { status: 200 });
        }
      }
      if (kind === "pulls" && sub === "merge" && method === "PUT") {
        const { sha, merge_method } = (await request.json()) as {
          sha?: string;
          merge_method?: string;
        };
        const outcome = world.merge(ref, sha ?? pr.headSha, merge_method ?? "merge");
        if (outcome.kind === "merged") {
          return json({
            sha: outcome.sha,
            merged: true,
            message: "Pull Request successfully merged",
          });
        }
        if (outcome.kind === "sha_mismatch") {
          return json(
            { message: "Head branch was modified. Review and try the merge again." },
            { status: 409 },
          );
        }
        if (outcome.kind === "method_not_allowed") {
          return json({ message: "Merge method not allowed for this repository" }, { status: 405 });
        }
        return json({ message: "Pull Request is not mergeable" }, { status: 405 });
      }
      return notFound();
    }),
  ];
}
