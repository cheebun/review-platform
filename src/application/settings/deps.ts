import type { CredentialStore } from "../../ports/credential-store";
import type { GitHubVerifier } from "../../ports/github-verifier";
import type { RateLimiter } from "../../ports/rate-limiter";
import type { ReviewEventRepo } from "../../ports/review-event-repo";
import type { SettingsRepo } from "../../ports/settings-repo";
import type { Clock, IdGenerator, Logger } from "../../ports/system";
import type { TokenCipher } from "../../ports/token-cipher";

/** The ports the settings use cases need. Field names match the container's `Ports`. */
export interface SettingsDeps {
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  rateLimiter: RateLimiter;
  githubCredentials: CredentialStore;
  tokenCipher: TokenCipher;
  githubRepos: SettingsRepo;
  reviewEvents: ReviewEventRepo;
  githubVerifier: GitHubVerifier;
}

/** Read-only subset, for `getGithubAvailability` and `resolveGithubToken`. */
export type GithubReadDeps = Pick<SettingsDeps, "githubCredentials" | "tokenCipher">;
