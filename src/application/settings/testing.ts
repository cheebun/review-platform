import type { Actor } from "../../domain/shared/actor";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { FakeGitHubVerifier } from "../../testing/fakes/fake-github-verifier";
import { FakeTokenCipher } from "../../testing/fakes/fake-token-cipher";
import { InMemoryCredentialStore } from "../../testing/fakes/in-memory-credential-store";
import { InMemoryRateLimiter } from "../../testing/fakes/in-memory-rate-limiter";
import { InMemoryReviewEventRepo } from "../../testing/fakes/in-memory-review-event-repo";
import { InMemorySettingsRepo } from "../../testing/fakes/in-memory-settings-repo";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { SequenceIdGenerator } from "../../testing/fakes/sequence-id-generator";
import type { SettingsDeps } from "./deps";

// Test sentinels, never real credentials.
export const TOKEN = "github_pat_SENTINEL0123456789abcdefWXYZ";
export const TOKEN_2 = "ghp_SECONDSENTINEL0123456789abcdefQRST";
export const NOW = new Date("2026-11-04T03:00:00.000Z");
export const alice: Actor = { kind: "user", userId: "u-alice", email: "a@example.com" };
export const machine: Actor = { kind: "machine", name: "machine" };

export function settingsSetup() {
  const clock = new FakeClock(NOW);
  const githubVerifier = new FakeGitHubVerifier();
  const tokenCipher = new FakeTokenCipher();
  const reviewEvents = new InMemoryReviewEventRepo();
  const githubCredentials = new InMemoryCredentialStore(reviewEvents);
  const githubRepos = new InMemorySettingsRepo(reviewEvents);
  const logger = new MemoryLogger();
  const deps: SettingsDeps = {
    clock,
    ids: new SequenceIdGenerator(),
    logger,
    rateLimiter: new InMemoryRateLimiter(clock),
    githubCredentials,
    tokenCipher,
    githubRepos,
    reviewEvents,
    githubVerifier,
  };
  return {
    deps,
    clock,
    githubVerifier,
    tokenCipher,
    githubCredentials,
    githubRepos,
    reviewEvents,
    logger,
  };
}
