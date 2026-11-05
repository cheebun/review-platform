import { describe, expect, it } from "vitest";
import { FAKE_GITHUB_BASE_URL, githubHandlers } from "../../testing/http/github/handlers";
import { GithubWorld } from "../../testing/http/github/world";
import { server } from "../../testing/http/server";
import { OctokitGitHub } from "./octokit-github";

const ref = { owner: "acme", repo: "app", number: 1, url: "https://github.com/acme/app/pull/1" };

function setup(options: { mergeableRetryDelaysMs?: readonly number[] } = {}) {
  const world = new GithubWorld();
  world.addPr({ owner: "acme", repo: "app", number: 1 });
  server.use(...githubHandlers(world));
  const slept: number[] = [];
  const impl = new OctokitGitHub({
    token: "ghp_fake_token_for_tests",
    userAgent: "agent-ops-test",
    baseUrl: FAKE_GITHUB_BASE_URL,
    retry: { maxRetries: 0 },
    sleep: async (ms) => void slept.push(ms),
    ...options,
  });
  return { world, impl, slept };
}

describe("OctokitGitHub mergeable re-read", () => {
  it("backs off 300, 600, 1200 ms between reads while GitHub is computing", async () => {
    const { world, impl, slept } = setup();
    world.setMergeableComputing(ref, 100);
    const pr = await impl.getPullRequest(ref, { awaitMergeable: true });
    expect(pr).toMatchObject({ ok: true, value: { mergeable: null, mergeableState: "unknown" } });
    expect(slept).toEqual([300, 600, 1200]);
  });

  it("stops waiting as soon as GitHub answers", async () => {
    const { world, impl, slept } = setup();
    world.setMergeableComputing(ref, 1);
    const pr = await impl.getPullRequest(ref, { awaitMergeable: true });
    expect(pr).toMatchObject({ ok: true, value: { mergeable: true, mergeableState: "clean" } });
    expect(slept).toEqual([300]);
  });

  it("a plain read never sleeps", async () => {
    const { world, impl, slept } = setup();
    world.setMergeableComputing(ref, 100);
    await impl.getPullRequest(ref);
    await impl.getDiff(ref);
    expect(slept).toEqual([]);
  });

  it("caps the configured delays at MERGEABLE_MAX_READS - 1 and rejects unsafe ones", async () => {
    const { world, impl, slept } = setup({ mergeableRetryDelaysMs: [1, 2, 3, 4, 5] });
    world.setMergeableComputing(ref, 100);
    await impl.getPullRequest(ref, { awaitMergeable: true });
    expect(slept).toEqual([1, 2, 3]);
    expect(() => setup({ mergeableRetryDelaysMs: [-1] })).toThrow(/mergeableRetryDelaysMs/);
    expect(() => setup({ mergeableRetryDelaysMs: [Number.NaN] })).toThrow(/mergeableRetryDelaysMs/);
  });
});
