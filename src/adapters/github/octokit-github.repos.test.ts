import { delay, http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { FAKE_GITHUB_BASE_URL, githubHandlers } from "../../testing/http/github/handlers";
import { GithubWorld } from "../../testing/http/github/world";
import { server } from "../../testing/http/server";
import { OctokitGitHub, type OctokitGitHubOptions } from "./octokit-github";

const BASE = FAKE_GITHUB_BASE_URL;
// A test value, never a real credential.
const TOKEN = "ghp_fake_token_for_tests";

let urls: URL[];
let world: GithubWorld;
let sleeps: number[];

const make = (extra: Partial<OctokitGitHubOptions> = {}) =>
  new OctokitGitHub({
    token: TOKEN,
    userAgent: "agent-ops-test/1.0",
    baseUrl: BASE,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });

const seed = (n: number) => {
  for (let i = 0; i < n; i++) {
    world.addAccessibleRepo({ fullName: `org/repo-${String(i).padStart(4, "0")}` });
  }
};

beforeEach(() => {
  urls = [];
  sleeps = [];
  world = new GithubWorld();
  server.use(...githubHandlers(world));
  server.events.on("request:start", ({ request }) => {
    urls.push(new URL(request.url));
  });
  return () => server.events.removeAllListeners();
});

describe("OctokitGitHub.listAccessibleRepos", () => {
  it("asks GET /user/repos for owner, collaborator and org repos, 100 per page, by name", async () => {
    seed(1);
    const result = await make().listAccessibleRepos();
    expect(result.ok).toBe(true);
    expect(urls).toHaveLength(1);
    const url = urls[0]!;
    expect(url.pathname).toBe("/user/repos");
    expect(url.searchParams.get("affiliation")).toBe("owner,collaborator,organization_member");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("sort")).toBe("full_name");
  });

  it("retries a 5xx once, then lists", async () => {
    seed(2);
    world.failNext({ kind: "bad_gateway" });
    const result = await make().listAccessibleRepos();
    expect(result).toEqual({
      ok: true,
      value: {
        repos: [
          { fullName: "org/repo-0000", private: false, archived: false, canPush: true },
          { fullName: "org/repo-0001", private: false, archived: false, canPush: true },
        ],
        truncated: false,
      },
    });
    expect(urls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it("waits out a short secondary rate limit, then lists", async () => {
    seed(1);
    server.use(
      http.get(
        `${BASE}/user/repos`,
        () =>
          HttpResponse.json(
            { message: "secondary rate limit" },
            { status: 403, headers: { "retry-after": "2" } },
          ),
        { once: true },
      ),
    );
    const result = await make().listAccessibleRepos();
    expect(result.ok && result.value.repos).toHaveLength(1);
    expect(sleeps).toEqual([2000]);
  });

  it("skips malformed entries instead of failing the listing", async () => {
    server.use(
      http.get(`${BASE}/user/repos`, () =>
        HttpResponse.json([
          { full_name: "acme/ok", private: true, archived: false, permissions: { push: false } },
          { full_name: "acme/no-flags", private: false },
          { full_name: "not a repo", private: false },
          { full_name: "acme/x", private: "yes" },
          null,
        ]),
      ),
    );
    const result = await make().listAccessibleRepos();
    expect(result).toEqual({
      ok: true,
      value: {
        repos: [
          { fullName: "acme/ok", private: true, archived: false, canPush: false },
          { fullName: "acme/no-flags", private: false, archived: false, canPush: false },
        ],
        truncated: false,
      },
    });
  });

  it("a response that is not a list is a non-retryable upstream error", async () => {
    server.use(http.get(`${BASE}/user/repos`, () => HttpResponse.json({ message: "nope" })));
    expect(await make().listAccessibleRepos()).toEqual({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: false },
    });
  });

  it("stops once the time budget is spent between pages, marking the list truncated", async () => {
    seed(250);
    let clock = 0;
    const gh = make({
      now: () => {
        const value = clock;
        clock += 8_000;
        return value;
      },
    });
    const result = await gh.listAccessibleRepos();
    expect(result.ok && result.value.repos).toHaveLength(200);
    expect(result.ok && result.value.truncated).toBe(true);
    expect(urls).toHaveLength(2);
  });

  it("a page still in flight when the budget runs out keeps the pages already read", async () => {
    seed(150);
    let served = 0;
    server.use(
      http.get(`${BASE}/user/repos`, async () => {
        served++;
        // The second page hangs past the budget; the first falls through to the world.
        if (served === 2) await delay(2_000);
        return undefined;
      }),
    );
    const result = await make({
      reposBudgetMs: 150,
      retry: { maxRetries: 0 },
    }).listAccessibleRepos();
    expect(result).toMatchObject({ ok: true, value: { truncated: true } });
    expect(result.ok && result.value.repos).toHaveLength(100);
  });

  it("a caller abort is an error, never a partial list", async () => {
    seed(1);
    const controller = new AbortController();
    controller.abort();
    const result = await make().listAccessibleRepos({ signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("upstream");
  });

  it("rejects a non-positive budget at construction", () => {
    expect(() => make({ reposBudgetMs: 0 })).toThrow(/reposBudgetMs/);
  });
});
