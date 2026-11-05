import { server } from "../../testing/http/server";
import { githubContract } from "../../testing/contracts/github.contract";
import { FAKE_GITHUB_BASE_URL, githubHandlers } from "../../testing/http/github/handlers";
import { GithubWorld } from "../../testing/http/github/world";
import { OctokitGitHub } from "./octokit-github";

githubContract(async () => {
  const world = new GithubWorld();
  server.use(...githubHandlers(world));
  const impl = new OctokitGitHub({
    token: "ghp_fake_token_for_tests",
    userAgent: "agent-ops-test",
    baseUrl: FAKE_GITHUB_BASE_URL,
    mergeMethods: ["merge"],
    // The contract states single-request semantics (one scripted fault, one error); retries are
    // covered in octokit-github.gate.test.ts.
    retry: { maxRetries: 0 },
    // The mergeable re-read backoff is asserted in octokit-github.mergeable.test.ts.
    sleep: async () => {},
  });
  return { impl, world, advance: async () => {}, cleanup: async () => {} };
});
