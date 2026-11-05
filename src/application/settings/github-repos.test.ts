import { beforeEach, describe, expect, it } from "vitest";
import { FakeGitHub } from "../../testing/fakes/fake-github";
import { GITHUB_REPO_LIST_LIMIT, listAccessibleGithubRepos } from "./github-repos";
import { saveGithubToken } from "./github-token";
import { alice, machine, settingsSetup, TOKEN } from "./testing";

let s: ReturnType<typeof settingsSetup>;
let github: FakeGitHub;
const deps = () => ({ ...s.deps, github });

beforeEach(() => {
  s = settingsSetup();
  github = new FakeGitHub();
});

const saved = async () => {
  s.githubVerifier.acceptToken(TOKEN);
  expect((await saveGithubToken(s.deps, alice, { token: TOKEN })).ok).toBe(true);
};

describe("listAccessibleGithubRepos", () => {
  it("a machine actor is forbidden and nothing reaches GitHub", async () => {
    await saved();
    const r = await listAccessibleGithubRepos(deps(), machine);
    expect(r).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(github.world.count("listAccessibleRepos")).toBe(0);
  });

  it("no token: not_configured github, no GitHub call, no rate-limit hit", async () => {
    for (let i = 0; i < GITHUB_REPO_LIST_LIMIT.limit + 1; i++) {
      expect(await listAccessibleGithubRepos(deps(), alice)).toEqual({
        ok: false,
        error: { kind: "not_configured", feature: "github" },
      });
    }
    expect(github.world.count("listAccessibleRepos")).toBe(0);
    await saved();
    expect((await listAccessibleGithubRepos(deps(), alice)).ok).toBe(true);
  });

  it("an undecryptable token: not_configured with needs_reset", async () => {
    await saved();
    s.tokenCipher.rotate();
    expect(await listAccessibleGithubRepos(deps(), alice)).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "github", reason: "needs_reset" },
    });
    expect(github.world.count("listAccessibleRepos")).toBe(0);
  });

  it("hides archived repos and returns only names and flags, never the token", async () => {
    await saved();
    github.world.addAccessibleRepo({ fullName: "acme/web", canPush: true });
    github.world.addAccessibleRepo({ fullName: "acme/old", archived: true });
    github.world.addAccessibleRepo({ fullName: "Acme/Secret", private: true, canPush: false });
    const r = await listAccessibleGithubRepos(deps(), alice);
    expect(r).toEqual({
      ok: true,
      value: {
        repos: [
          { fullName: "Acme/Secret", private: true, canPush: false },
          { fullName: "acme/web", private: false, canPush: true },
        ],
        truncated: false,
      },
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("passes truncation through", async () => {
    await saved();
    for (let i = 0; i < 1001; i++) github.world.addAccessibleRepo({ fullName: `o/r${i}` });
    const r = await listAccessibleGithubRepos(deps(), alice);
    expect(r.ok && r.value.truncated).toBe(true);
  });

  it(`allows ${GITHUB_REPO_LIST_LIMIT.limit} listings per window per user, then rate_limited`, async () => {
    await saved();
    for (let i = 0; i < GITHUB_REPO_LIST_LIMIT.limit; i++) {
      expect((await listAccessibleGithubRepos(deps(), alice)).ok).toBe(true);
    }
    const limited = await listAccessibleGithubRepos(deps(), alice);
    expect(limited).toMatchObject({ ok: false, error: { kind: "rate_limited" } });
    expect(github.world.count("listAccessibleRepos")).toBe(GITHUB_REPO_LIST_LIMIT.limit);
    s.clock.advance(GITHUB_REPO_LIST_LIMIT.windowMs + 1);
    expect((await listAccessibleGithubRepos(deps(), alice)).ok).toBe(true);
  });

  it("a GitHub failure is returned as is (a rejected token stays forbidden)", async () => {
    await saved();
    github.world.failNext({ kind: "unauthorized" });
    expect(await listAccessibleGithubRepos(deps(), alice)).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
    github.world.failNext({ kind: "bad_gateway" });
    expect(await listAccessibleGithubRepos(deps(), alice)).toMatchObject({
      ok: false,
      error: { kind: "upstream", retryable: true },
    });
  });
});
