import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import type { PrRef } from "../../domain/github/pr-ref";
import { FAKE_GITHUB_BASE_URL } from "../../testing/http/github/handlers";
import { server } from "../../testing/http/server";
import type { MergeMethod } from "../../ports/github";
import { OctokitGitHub, type OctokitGitHubOptions } from "./octokit-github";

const BASE = FAKE_GITHUB_BASE_URL;
const REPO = { owner: "acme", repo: "widgets" };
const ref: PrRef = { ...REPO, number: 1, url: "https://github.com/acme/widgets/pull/1" };
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOW = Date.parse("2026-06-30T12:00:00Z");

let sleeps: number[];
let requests: string[];

const make = (extra: Partial<OctokitGitHubOptions> = {}) =>
  new OctokitGitHub({
    token: "ghp_fake_token_for_tests",
    userAgent: "agent-ops-test/1.0",
    baseUrl: BASE,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });

beforeEach(() => {
  sleeps = [];
  requests = [];
  server.events.on("request:start", ({ request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return () => server.events.removeAllListeners();
});

const linkTo = (path: string, page: number) =>
  `<${BASE}${path}?per_page=100&page=${page}>; rel="next"`;

const run = (id: number, name: string, status: string, conclusion: string | null) => ({
  id,
  name,
  status,
  conclusion,
});

/** Serves check runs and statuses, each split into pages. */
const serveChecks = (
  runPages: ReturnType<typeof run>[][],
  statusPages: { id: number; context: string; state: string }[][] = [[]],
) => {
  const runsPath = `/repos/acme/widgets/commits/${SHA}/check-runs`;
  const statusPath = `/repos/acme/widgets/commits/${SHA}/statuses`;
  server.use(
    http.get(`${BASE}${runsPath}`, ({ request }) => {
      const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
      const items = runPages[page - 1] ?? [];
      const headers: Record<string, string> =
        page < runPages.length ? { link: linkTo(runsPath, page + 1) } : {};
      return HttpResponse.json(
        { total_count: runPages.flat().length, check_runs: items },
        { headers },
      );
    }),
    http.get(`${BASE}${statusPath}`, ({ request }) => {
      const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
      const items = statusPages[page - 1] ?? [];
      const headers: Record<string, string> =
        page < statusPages.length ? { link: linkTo(statusPath, page + 1) } : {};
      return HttpResponse.json(items, { headers });
    }),
  );
};

describe("getChecks", () => {
  it("success, neutral and skipped check runs plus a success status are green", async () => {
    serveChecks(
      [
        [
          run(1, "build", "completed", "success"),
          run(2, "lint", "completed", "neutral"),
          run(3, "deploy-preview", "completed", "skipped"),
        ],
      ],
      [[{ id: 10, context: "ci/legacy", state: "success" }]],
    );
    expect(await make().getChecks(REPO, SHA)).toEqual({
      ok: true,
      value: { state: "green", failing: [], pending: [], total: 4 },
    });
  });

  it("follows pagination for check runs and statuses", async () => {
    serveChecks(
      [[run(1, "build", "completed", "success")], [run(2, "e2e", "completed", "failure")]],
      [
        [{ id: 10, context: "ci/a", state: "success" }],
        [{ id: 11, context: "ci/b", state: "pending" }],
      ],
    );
    expect(await make().getChecks(REPO, SHA)).toEqual({
      ok: true,
      value: { state: "failing", failing: ["e2e"], pending: ["ci/b"], total: 4 },
    });
  });

  it("any non-success conclusion fails and unfinished runs are pending", async () => {
    serveChecks([
      [
        run(1, "a", "completed", "failure"),
        run(2, "b", "completed", "cancelled"),
        run(3, "c", "completed", "timed_out"),
        run(4, "d", "completed", "action_required"),
        run(5, "e", "in_progress", null),
        run(6, "f", "queued", null),
      ],
    ]);
    expect(await make().getChecks(REPO, SHA)).toEqual({
      ok: true,
      value: { state: "failing", failing: ["a", "b", "c", "d"], pending: ["e", "f"], total: 6 },
    });
  });

  it("only pending runs make the result pending", async () => {
    serveChecks([[run(1, "build", "completed", "success"), run(2, "e2e", "waiting", null)]]);
    expect(await make().getChecks(REPO, SHA)).toMatchObject({
      ok: true,
      value: { state: "pending", failing: [], pending: ["e2e"] },
    });
  });

  it("uses only the newest status per context; error and failure fail", async () => {
    serveChecks(
      [[]],
      [
        [
          { id: 30, context: "ci/a", state: "success" },
          { id: 29, context: "ci/b", state: "error" },
          { id: 20, context: "ci/a", state: "failure" },
          { id: 5, context: "ci/c", state: "failure" },
        ],
      ],
    );
    expect(await make().getChecks(REPO, SHA)).toEqual({
      ok: true,
      value: { state: "failing", failing: ["ci/b", "ci/c"], pending: [], total: 3 },
    });
  });

  it("a commit with no checks is green with total 0", async () => {
    serveChecks([[]]);
    expect(await make().getChecks(REPO, SHA)).toEqual({
      ok: true,
      value: { state: "green", failing: [], pending: [], total: 0 },
    });
  });

  it("a malformed check run is a non-retryable upstream error", async () => {
    serveChecks([[{ id: 1, name: "build" } as unknown as ReturnType<typeof run>]]);
    expect(await make().getChecks(REPO, SHA)).toEqual({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: false },
    });
  });

  it("an unknown conclusion fails closed", async () => {
    serveChecks([[run(1, "build", "completed", "something_new")]]);
    expect(await make().getChecks(REPO, SHA)).toMatchObject({
      ok: true,
      value: { state: "failing", failing: ["build"] },
    });
  });

  it("rejects a malformed SHA without calling GitHub", async () => {
    serveChecks([[]]);
    expect(await make().getChecks(REPO, "../../x")).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
    expect(requests).toEqual([]);
  });
});

type ReviewRow = {
  id: number;
  login: string;
  state: string;
  commit_id: string | null;
};

const serveReviews = (pages: ReviewRow[][], me = "Reviewer-Bot") => {
  const path = "/repos/acme/widgets/pulls/1/reviews";
  server.use(
    http.get(`${BASE}/user`, () => HttpResponse.json({ login: me, id: 99 })),
    http.get(`${BASE}${path}`, ({ request }) => {
      const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
      const headers: Record<string, string> =
        page < pages.length ? { link: linkTo(path, page + 1) } : {};
      const items = (pages[page - 1] ?? []).map((r) => ({
        id: r.id,
        user: { login: r.login, id: r.login.toLowerCase() === me.toLowerCase() ? 99 : r.id + 1000 },
        state: r.state,
        commit_id: r.commit_id,
        body: "",
      }));
      return HttpResponse.json(items, { headers });
    }),
  );
};

describe("hasApproval", () => {
  const me = "reviewer-bot";
  const cases: [string, ReviewRow[], boolean][] = [
    [
      "latest own APPROVED at the SHA",
      [{ id: 1, login: me, state: "APPROVED", commit_id: SHA }],
      true,
    ],
    [
      "own APPROVED at another SHA",
      [{ id: 1, login: me, state: "APPROVED", commit_id: OTHER }],
      false,
    ],
    [
      "APPROVED then CHANGES_REQUESTED",
      [
        { id: 1, login: me, state: "APPROVED", commit_id: SHA },
        { id: 2, login: me, state: "CHANGES_REQUESTED", commit_id: SHA },
      ],
      false,
    ],
    [
      "a later dismissed review is ignored",
      [
        { id: 1, login: me, state: "APPROVED", commit_id: SHA },
        { id: 2, login: me, state: "DISMISSED", commit_id: SHA },
      ],
      true,
    ],
    [
      "a dismissed approval does not count",
      [{ id: 1, login: me, state: "DISMISSED", commit_id: SHA }],
      false,
    ],
    [
      "a later comment-only review does not revoke the approval",
      [
        { id: 1, login: me, state: "APPROVED", commit_id: SHA },
        { id: 2, login: me, state: "COMMENTED", commit_id: SHA },
      ],
      true,
    ],
    [
      "another account's approval does not count",
      [{ id: 1, login: "someone-else", state: "APPROVED", commit_id: SHA }],
      false,
    ],
    [
      "the newest review wins regardless of response order",
      [
        { id: 7, login: me, state: "APPROVED", commit_id: SHA },
        { id: 3, login: me, state: "CHANGES_REQUESTED", commit_id: SHA },
      ],
      true,
    ],
    ["no reviews", [], false],
  ];

  for (const [name, rows, expected] of cases) {
    it(`${name} -> ${expected}`, async () => {
      serveReviews([rows]);
      expect(await make().hasApproval(ref, SHA)).toEqual({ ok: true, value: expected });
    });
  }

  it("finds the latest review on a later page", async () => {
    serveReviews([
      [{ id: 1, login: me, state: "CHANGES_REQUESTED", commit_id: SHA }],
      [{ id: 2, login: me, state: "APPROVED", commit_id: SHA }],
    ]);
    expect(await make().hasApproval(ref, SHA)).toEqual({ ok: true, value: true });
  });

  it("a malformed review list is a non-retryable upstream error", async () => {
    server.use(
      http.get(`${BASE}/user`, () => HttpResponse.json({ login: me, id: 99 })),
      http.get(`${BASE}/repos/acme/widgets/pulls/1/reviews`, () =>
        HttpResponse.json([{ id: "x", state: 3 }]),
      ),
    );
    expect(await make().hasApproval(ref, SHA)).toEqual({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: false },
    });
  });

  it("rejects a malformed SHA without calling GitHub", async () => {
    serveReviews([[]]);
    expect(await make().hasApproval(ref, "")).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
    expect(requests).toEqual([]);
  });
});

describe("merge method and pinning", () => {
  let mergeBodies: { sha?: string; merge_method?: string }[];
  const mergePath = `${BASE}/repos/acme/widgets/pulls/1/merge`;
  const serveMerge = () =>
    server.use(
      http.put(mergePath, async ({ request }) => {
        const body = (await request.json()) as { sha?: string; merge_method?: string };
        mergeBodies.push(body);
        return HttpResponse.json({ merged: true, sha: "c".repeat(40), message: "ok" });
      }),
    );
  const serveRepo = (allow: { merge?: boolean; squash?: boolean; rebase?: boolean }) =>
    server.use(
      http.get(`${BASE}/repos/acme/widgets`, () =>
        HttpResponse.json({
          full_name: "acme/widgets",
          allow_merge_commit: allow.merge,
          allow_squash_merge: allow.squash,
          allow_rebase_merge: allow.rebase,
        }),
      ),
    );

  beforeEach(() => {
    mergeBodies = [];
  });

  it("uses the single configured method and pins the SHA", async () => {
    serveMerge();
    const result = await make({ mergeMethods: ["squash"] }).merge(ref, { sha: SHA });
    expect(result).toEqual({ ok: true, value: { merged: true, sha: "c".repeat(40) } });
    expect(mergeBodies).toEqual([{ sha: SHA, merge_method: "squash" }]);
  });

  it("picks the first configured method the repository allows", async () => {
    serveMerge();
    serveRepo({ merge: true, squash: true, rebase: false });
    await make({ mergeMethods: ["rebase", "squash", "merge"] }).merge(ref, { sha: SHA });
    expect(mergeBodies).toEqual([{ sha: SHA, merge_method: "squash" }]);
  });

  it("falls back to the first preference when the repository hides its merge settings", async () => {
    serveMerge();
    serveRepo({});
    await make({ mergeMethods: ["rebase", "squash"] }).merge(ref, { sha: SHA });
    expect(mergeBodies).toEqual([{ sha: SHA, merge_method: "rebase" }]);
  });

  it("is a conflict without a merge call when the repository allows none of them", async () => {
    serveMerge();
    serveRepo({ merge: true, squash: false, rebase: false });
    const result = await make({ mergeMethods: ["rebase", "squash"] }).merge(ref, { sha: SHA });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "conflict",
        reason: "repository allows none of the configured merge methods (rebase, squash)",
      },
    });
    expect(mergeBodies).toEqual([]);
  });

  it("a per-call method overrides the configuration", async () => {
    serveMerge();
    await make({ mergeMethods: ["merge"] }).merge(ref, { sha: SHA, method: "rebase" });
    expect(mergeBodies).toEqual([{ sha: SHA, merge_method: "rebase" }]);
  });

  it("without any configured method it is a validation error and makes no request", async () => {
    serveMerge();
    expect(await make().merge(ref, { sha: SHA })).toEqual({
      ok: false,
      error: { kind: "validation", field: "mergeMethod", message: "no merge method configured" },
    });
    expect(requests).toEqual([]);
  });

  it("rejects an unknown method and a malformed SHA without a request", async () => {
    serveMerge();
    const gh = make({ mergeMethods: ["merge"] });
    expect(
      await gh.merge(ref, { sha: SHA, method: "fast-forward" as unknown as MergeMethod }),
    ).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await gh.merge(ref, { sha: "x y" })).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
    expect(requests).toEqual([]);
  });

  it("rejects an unknown method in the configuration", () => {
    expect(() => make({ mergeMethods: ["octopus" as MergeMethod] })).toThrow(/merge method/);
  });

  for (const [status, message] of [
    [405, "Merge commits are not allowed on this repository."],
    [409, "Head branch was modified. Review and try the merge again."],
    [422, 'Required status check "build" is expected.'],
  ] as const) {
    it(`${status} is a conflict that keeps GitHub's reason`, async () => {
      server.use(http.put(mergePath, () => HttpResponse.json({ message }, { status })));
      expect(await make({ mergeMethods: ["merge"] }).merge(ref, { sha: SHA })).toEqual({
        ok: false,
        error: { kind: "conflict", reason: `GitHub ${status}: ${message}` },
      });
    });
  }

  it("the preserved reason is stripped of control characters and bounded", async () => {
    const message = `bad\u0000\n${"x".repeat(500)}`;
    server.use(http.put(mergePath, () => HttpResponse.json({ message }, { status: 405 })));
    const result = await make({ mergeMethods: ["merge"] }).merge(ref, { sha: SHA });
    const reason = !result.ok && result.error.kind === "conflict" ? result.error.reason : "";
    expect(reason.startsWith("GitHub 405: bad x")).toBe(true);
    expect([...reason].some((ch) => ch.charCodeAt(0) < 0x20)).toBe(false);
    expect(reason.length).toBeLessThanOrEqual(212);
  });

  it("a merge:true response without a SHA is a non-retryable upstream error", async () => {
    server.use(http.put(mergePath, () => HttpResponse.json({ merged: true })));
    expect(await make({ mergeMethods: ["merge"] }).merge(ref, { sha: SHA })).toEqual({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: false },
    });
  });
});

describe("retry and timeout", () => {
  const prPath = `${BASE}/repos/acme/widgets/pulls/1`;
  const pr = {
    title: "t",
    body: null,
    user: { login: "a" },
    base: { ref: "main", sha: OTHER },
    head: { ref: "f", sha: SHA },
    state: "open",
    merged: false,
    draft: false,
    changed_files: 1,
    html_url: "u",
  };
  /** Replies with each scripted response in turn, then with the PR. */
  const script = (
    path: string,
    replies: (() => Response)[],
    method: "get" | "put" | "post" = "get",
  ) => {
    let i = 0;
    server.use(
      http[method](path, () => {
        const reply = replies[i++];
        return reply ? reply() : HttpResponse.json(pr);
      }),
    );
  };
  const status =
    (code: number, headers: Record<string, string> = {}) =>
    () =>
      HttpResponse.json({ message: "x" }, { status: code, headers });

  it("retries a read on 5xx with exponential backoff, then succeeds", async () => {
    script(prPath, [status(502), status(503)]);
    const result = await make().getPullRequest(ref);
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("gives up after the retry budget and reports a retryable upstream error", async () => {
    script(prPath, [status(500), status(500), status(500), status(500)]);
    expect(await make().getPullRequest(ref)).toEqual({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: true },
    });
    expect(requests).toHaveLength(3);
  });

  it("retries a read after a timeout", async () => {
    let calls = 0;
    server.use(
      http.get(prPath, async () => {
        calls += 1;
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 300));
        return HttpResponse.json(pr);
      }),
    );
    expect((await make({ timeoutMs: 30 }).getPullRequest(ref)).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("waits out a secondary rate limit (retry-after) and retries", async () => {
    script(prPath, [status(403, { "retry-after": "2" })]);
    expect((await make().getPullRequest(ref)).ok).toBe(true);
    expect(sleeps).toEqual([2000]);
  });

  it("does not wait longer than the cap; the rate limit is returned instead", async () => {
    script(prPath, [status(429, { "retry-after": "120" })]);
    expect(await make().getPullRequest(ref)).toEqual({
      ok: false,
      error: { kind: "rate_limited", retryAfterMs: 120_000 },
    });
    expect(requests).toHaveLength(1);
  });

  it("does not retry a primary rate limit", async () => {
    script(prPath, [
      status(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 5) }),
    ]);
    expect(await make().getPullRequest(ref)).toEqual({
      ok: false,
      error: { kind: "rate_limited", retryAfterMs: 5_000 },
    });
    expect(requests).toHaveLength(1);
  });

  it("never retries a merge after a 5xx: the merge may have happened", async () => {
    script(`${prPath}/merge`, [status(502)], "put");
    expect(await make({ mergeMethods: ["merge"] }).merge(ref, { sha: SHA })).toEqual({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: true },
    });
    expect(requests).toEqual([`PUT /repos/acme/widgets/pulls/1/merge`]);
  });

  it("never retries a merge after a network error", async () => {
    server.use(http.put(`${prPath}/merge`, () => HttpResponse.error()));
    await make({ mergeMethods: ["merge"] }).merge(ref, { sha: SHA });
    expect(requests).toHaveLength(1);
  });

  it("retries a merge rejected by a secondary rate limit, which GitHub never processed", async () => {
    let calls = 0;
    server.use(
      http.put(`${prPath}/merge`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: "x" }, { status: 429, headers: { "retry-after": "1" } })
          : HttpResponse.json({ merged: true, sha: "c".repeat(40) });
      }),
    );
    expect(await make({ mergeMethods: ["merge"] }).merge(ref, { sha: SHA })).toEqual({
      ok: true,
      value: { merged: true, sha: "c".repeat(40) },
    });
    expect(calls).toBe(2);
  });

  it("never retries other writes after a 5xx", async () => {
    script(`${BASE}/repos/acme/widgets/issues/1/comments`, [status(502)], "post");
    await make().createComment(ref, "hello");
    expect(requests).toHaveLength(1);
  });

  it("maxRetries 0 disables retrying", async () => {
    script(prPath, [status(502)]);
    await make({ retry: { maxRetries: 0 } }).getPullRequest(ref);
    expect(requests).toHaveLength(1);
  });
});

describe("approve stays pinned", () => {
  it("an APPROVE review is submitted with commit_id", async () => {
    let payload: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/repos/acme/widgets/pulls/1/reviews`, async ({ request }) => {
        payload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 7 });
      }),
    );
    await make().submitReview(ref, { event: "APPROVE", commitId: SHA });
    expect(payload).toEqual({ event: "APPROVE", commit_id: SHA });
  });
});
