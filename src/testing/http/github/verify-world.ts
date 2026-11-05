import { http, HttpResponse } from "msw";
import { FAKE_GITHUB_BASE_URL } from "./handlers";

/** A probe's HTTP outcome: a status code, or a dropped connection. */
export type ProbeOutcome = number | "network";

export type VerifyRepo = {
  /** Status of `GET /repos/{owner}/{repo}`. */
  status: ProbeOutcome;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  /** The user's role on the repo (`permissions`); undefined omits the object. */
  permissions?: { admin: boolean; push: boolean; pull: boolean };
  /** Whether merge-related settings appear (GitHub shows them only with contents:write). */
  mergeSettings: boolean;
  pulls: ProbeOutcome;
  commits: ProbeOutcome;
  checkRuns: ProbeOutcome;
  combinedStatus: ProbeOutcome;
};

export const aVerifyRepo = (fullName: string, over: Partial<VerifyRepo> = {}): VerifyRepo => ({
  status: 200,
  fullName,
  private: true,
  defaultBranch: "main",
  permissions: { admin: false, push: true, pull: true },
  mergeSettings: true,
  pulls: 200,
  commits: 200,
  checkRuns: 200,
  combinedStatus: 200,
  ...over,
});

/**
 * HTTP-level fake of the read-only endpoints the verifier uses. Records every request so tests
 * can assert that only GETs were made. Tokens here are fake.
 */
export class VerifyWorld {
  user = { login: "octocat", avatar_url: "https://avatars.example.test/u/1" };
  userStatus: ProbeOutcome = 200;
  /** `X-OAuth-Scopes` value; null omits the header (fine-grained tokens). */
  scopes: string | null = null;
  readonly repos = new Map<string, VerifyRepo>();
  readonly requests: { method: string; path: string; auth: string | null }[] = [];

  addRepo(repo: VerifyRepo): this {
    this.repos.set(repo.fullName.toLowerCase(), repo);
    return this;
  }

  handlers(baseUrl = FAKE_GITHUB_BASE_URL) {
    return [
      http.all(`${baseUrl}/*`, ({ request }) => {
        const url = new URL(request.url);
        this.requests.push({
          method: request.method,
          path: url.pathname + url.search,
          auth: request.headers.get("authorization"),
        });
        const headers: Record<string, string> = {};
        if (this.scopes !== null) headers["x-oauth-scopes"] = this.scopes;
        const respond = (status: ProbeOutcome, body: object = {}) => {
          if (status === "network") return HttpResponse.error();
          return HttpResponse.json(status === 200 ? body : { message: "x" }, { status, headers });
        };
        if (request.method !== "GET")
          return HttpResponse.json({ message: "write" }, { status: 418 });
        const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (path.join("/") === "user") return respond(this.userStatus, this.user);
        if (path[0] !== "repos" || path.length < 3) return respond(404);
        const repo = this.repos.get(`${path[1]}/${path[2]}`.toLowerCase());
        if (!repo) return respond(404);
        const rest = path.slice(3).join("/");
        if (rest === "") {
          const [owner, name] = repo.fullName.split("/");
          return respond(repo.status, {
            name,
            full_name: repo.fullName,
            owner: { login: owner },
            private: repo.private,
            default_branch: repo.defaultBranch,
            temp_clone_token: "TEMPCLONE-SENTINEL",
            ...(repo.permissions ? { permissions: repo.permissions } : {}),
            ...(repo.mergeSettings
              ? { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false }
              : {}),
          });
        }
        if (rest === "pulls") return respond(repo.pulls, []);
        if (rest === "commits") return respond(repo.commits, []);
        if (rest === `commits/${repo.defaultBranch}/check-runs`) {
          return respond(repo.checkRuns, { total_count: 0, check_runs: [] });
        }
        if (rest === `commits/${repo.defaultBranch}/status`) {
          return respond(repo.combinedStatus, { state: "pending", statuses: [] });
        }
        return respond(404);
      }),
    ];
  }
}
