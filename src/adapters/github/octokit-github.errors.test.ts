import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import type { PrRef } from "../../domain/github/pr-ref";
import { server } from "../../testing/http/server";
import { FAKE_GITHUB_BASE_URL } from "../../testing/http/github/handlers";
import { OctokitGitHub } from "./octokit-github";

const BASE = FAKE_GITHUB_BASE_URL;
const ref: PrRef = {
  owner: "acme",
  repo: "widgets",
  number: 1,
  url: "https://github.com/acme/widgets/pull/1",
};
const NOW = Date.parse("2026-06-30T12:00:00Z");

const make = (extra: { timeoutMs?: number } = {}) =>
  new OctokitGitHub({
    token: "ghp_fake_token_for_tests",
    userAgent: "agent-ops-test/1.0",
    baseUrl: BASE,
    now: () => NOW,
    mergeMethods: ["merge"],
    sleep: async () => {},
    ...extra,
  });

const respond = (
  status: number,
  headers: Record<string, string> = {},
  body: object = { message: "x" },
) => server.use(http.all(`${BASE}/*`, () => HttpResponse.json(body, { status, headers })));

describe("OctokitGitHub error mapping (by status and headers, never by message)", () => {
  const cases: [string, number, Record<string, string>, unknown][] = [
    ["401", 401, {}, { kind: "forbidden", reason: expect.any(String) }],
    ["403 without rate-limit headers", 403, {}, { kind: "forbidden", reason: expect.any(String) }],
    [
      "403 with retry-after",
      403,
      { "retry-after": "12" },
      { kind: "rate_limited", retryAfterMs: 12_000 },
    ],
    [
      "403 with x-ratelimit-remaining 0 and reset",
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 90) },
      { kind: "rate_limited", retryAfterMs: 90_000 },
    ],
    [
      "429 with retry-after",
      429,
      { "retry-after": "5" },
      { kind: "rate_limited", retryAfterMs: 5_000 },
    ],
    [
      "reset already in the past clamps to 0",
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 - 10) },
      { kind: "rate_limited", retryAfterMs: 0 },
    ],
    ["404", 404, {}, { kind: "not_found", entity: "pull_request" }],
    ["422 outside merge", 422, {}, { kind: "validation", message: expect.any(String) }],
    ["500", 500, {}, { kind: "upstream", service: "github", retryable: true }],
    ["502", 502, {}, { kind: "upstream", service: "github", retryable: true }],
    ["503", 503, {}, { kind: "upstream", service: "github", retryable: true }],
    ["400", 400, {}, { kind: "upstream", service: "github", retryable: false }],
  ];

  for (const [name, status, headers, expected] of cases) {
    it(`${name} -> ${(expected as { kind: string }).kind}`, async () => {
      respond(status, headers, { message: "unrelated text that must not matter" });
      const result = await make().getPullRequest(ref);
      expect(result).toEqual({ ok: false, error: expected });
    });
  }

  for (const status of [405, 409, 422]) {
    it(`merge ${status} -> conflict`, async () => {
      respond(status);
      const result = await make().merge(ref, { sha: "abc" });
      expect(result).toMatchObject({ ok: false, error: { kind: "conflict" } });
    });
  }

  it("merge 403 stays forbidden and merge 404 stays not_found", async () => {
    respond(403);
    expect(await make().merge(ref, { sha: "abc" })).toMatchObject({ error: { kind: "forbidden" } });
    respond(404);
    expect(await make().merge(ref, { sha: "abc" })).toMatchObject({ error: { kind: "not_found" } });
  });

  it("a 200 merge response with merged:false is a conflict", async () => {
    respond(200, {}, { merged: false, message: "not merged", sha: "" });
    expect(await make().merge(ref, { sha: "abc" })).toMatchObject({ error: { kind: "conflict" } });
  });

  it("a network error is a retryable upstream error and never throws", async () => {
    server.use(http.all(`${BASE}/*`, () => HttpResponse.error()));
    expect(await make().getPullRequest(ref)).toEqual({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: true },
    });
  });

  it("a stalled request times out as a retryable upstream error", async () => {
    server.use(
      http.all(`${BASE}/*`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return HttpResponse.json({});
      }),
    );
    expect(await make({ timeoutMs: 30 }).getAuthenticatedLogin()).toEqual({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: true },
    });
  });

  it("a GraphQL NOT_FOUND error inside listing maps to not_found", async () => {
    server.use(
      http.get(`${BASE}/repos/acme/widgets/pulls`, () =>
        HttpResponse.json([
          {
            number: 1,
            title: "t",
            user: { login: "a" },
            html_url: "u",
            draft: false,
            updated_at: new Date(NOW).toISOString(),
            base: { ref: "main" },
            head: { ref: "b" },
          },
        ]),
      ),
      http.post(`${BASE}/graphql`, () =>
        HttpResponse.json({ data: null, errors: [{ type: "NOT_FOUND", message: "x" }] }),
      ),
    );
    const result = await make().listOpenPullRequests(
      { owner: "acme", repo: "widgets" },
      { authors: ["a"], maxAgeDays: 15, now: new Date(NOW) },
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });
});

describe("OctokitGitHub request shape", () => {
  let seen: Request | undefined;
  beforeEach(() => {
    seen = undefined;
    server.use(
      http.all(`${BASE}/*`, ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ login: "reviewer-bot" });
      }),
    );
  });

  it("sends the token and user agent it was constructed with, not environment values", async () => {
    await make().getAuthenticatedLogin();
    expect(seen?.headers.get("authorization")).toBe("token ghp_fake_token_for_tests");
    expect(seen?.headers.get("user-agent")).toContain("agent-ops-test/1.0");
  });

  it("merge is pinned to the given SHA", async () => {
    server.use(
      http.put(`${BASE}/repos/acme/widgets/pulls/1/merge`, async ({ request }) => {
        const body = (await request.json()) as { sha: string; merge_method: string };
        return HttpResponse.json({ merged: true, sha: `m-${body.sha}-${body.merge_method}` });
      }),
    );
    expect(await make().merge(ref, { sha: "abc" })).toEqual({
      ok: true,
      value: { merged: true, sha: "m-abc-merge" },
    });
  });

  it("review submit sends commit_id and the invisible placeholder body for COMMENT", async () => {
    let payload: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/repos/acme/widgets/pulls/1/reviews`, async ({ request }) => {
        payload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 7 });
      }),
    );
    await make().submitReview(ref, { event: "COMMENT", commitId: "h1" });
    expect(payload).toEqual({ event: "COMMENT", commit_id: "h1", body: "<!-- -->" });
    await make().submitReview(ref, { event: "APPROVE", commitId: "h1" });
    expect(payload).toEqual({ event: "APPROVE", commit_id: "h1" });
  });
});
