import { InMemoryReviewUnitOfWork, FakeTimers } from "../application/review/testing";
import { ok } from "../domain/shared/result";
import type { ShipDeps } from "../application/ship/ship";
import { DEFAULT_REACTION_RETRY } from "../ports/reaction-outbox";
import type { Container, Ports } from "../server/container";
import { FakeGitHub } from "./fakes/fake-github";
import { FakeSlackVerifier } from "./fakes/fake-slack-verifier";
import { InMemoryReactionOutbox } from "./fakes/in-memory-reaction-outbox";
import { InMemoryReviewRecordRepo } from "./fakes/in-memory-review-record-repo";
import { InMemorySettingsStore } from "./fakes/in-memory-settings-store";
import { InMemorySetupUnitOfWork } from "./fakes/in-memory-setup-unit-of-work";
import { InMemoryThreadReviewIndex } from "./fakes/in-memory-thread-review-index";
import { FakeAuth } from "./fakes/fake-auth";
import { FakeLoginTokenHasher } from "./fakes/fake-login-token-hasher";
import { InMemoryAttemptLimiter } from "./fakes/in-memory-attempt-limiter";
import { FakeClock } from "./fakes/fake-clock";
import { FakeGitHubVerifier } from "./fakes/fake-github-verifier";
import { FakeTokenCipher } from "./fakes/fake-token-cipher";
import { InMemoryCredentialStore } from "./fakes/in-memory-credential-store";
import { InMemoryLoginTokenStore } from "./fakes/in-memory-login-token-store";
import { InMemoryReviewEventRepo } from "./fakes/in-memory-review-event-repo";
import { InMemorySettingsRepo } from "./fakes/in-memory-settings-repo";
import { FakeReviewer } from "./fakes/fake-reviewer";
import { InMemoryAppStateRepo } from "./fakes/in-memory-app-state-repo";
import { InMemoryEventDedupe } from "./fakes/in-memory-event-dedupe";
import { InMemoryRateLimiter } from "./fakes/in-memory-rate-limiter";
import { InMemoryReviewJobRepo } from "./fakes/in-memory-review-job-repo";
import { InMemoryThrottle } from "./fakes/in-memory-throttle";
import { InMemoryWakeUp } from "./fakes/in-memory-wake-up";
import { MemoryLogger } from "./fakes/memory-logger";
import { SequenceIdGenerator } from "./fakes/sequence-id-generator";

/** A container made only of in-memory fakes: no config, no network. */
export function createTestContainer(overrides: Partial<Ports> = {}): Container {
  const clock = overrides.clock ?? new FakeClock();
  // One event store, as in PG: the settings stores write their events into it.
  const reviewEvents = new InMemoryReviewEventRepo();
  const ids = overrides.ids ?? new SequenceIdGenerator();
  const logger = overrides.logger ?? new MemoryLogger();
  const reviewJobs = overrides.reviewJobs ?? new InMemoryReviewJobRepo(clock);
  const githubRepos = overrides.githubRepos ?? new InMemorySettingsRepo(reviewEvents);
  const reviewRecords = overrides.reviewRecords ?? new InMemoryReviewRecordRepo();
  const threadReviews = overrides.threadReviews ?? new InMemoryThreadReviewIndex(clock);
  const reactionOutbox =
    overrides.reactionOutbox ??
    new InMemoryReactionOutbox(clock, { ...DEFAULT_REACTION_RETRY, jitter: () => 0 });
  const reviewUnitOfWork =
    overrides.reviewUnitOfWork ??
    new InMemoryReviewUnitOfWork({
      jobs: reviewJobs,
      records: reviewRecords,
      events: reviewEvents,
      threads: threadReviews,
      outbox: reactionOutbox,
      clock,
    });
  const timers = overrides.timers ?? new FakeTimers();
  const github = overrides.github ?? new FakeGitHub();
  const shipDeps = (gh: Ports["github"]): ShipDeps => ({
    github: gh,
    records: reviewRecords,
    events: reviewEvents,
    jobs: reviewJobs,
    threads: threadReviews,
    uow: reviewUnitOfWork,
    repoList: async () => (await githubRepos.listRepos()).map((r) => r.canonical),
    clock,
    ids,
    logger,
    timers,
  });
  const reviewer = new FakeReviewer();
  const loginTokens = overrides.loginTokens ?? new InMemoryLoginTokenStore(clock);
  const settingsStore = overrides.settingsStore ?? new InMemorySettingsStore(reviewEvents);
  const githubCredentials =
    overrides.githubCredentials ?? new InMemoryCredentialStore(reviewEvents);
  const ports: Ports = {
    clock,
    ids,
    logger,
    reviewJobs,
    appState: new InMemoryAppStateRepo(clock),
    auth: new FakeAuth({ loginTokens }),
    githubCredentials,
    githubRepos,
    reviewEvents,
    reviewRecords,
    loginTokens,
    loginTokenHasher: new FakeLoginTokenHasher(),
    settingsStore,
    slackVerifier: new FakeSlackVerifier(),
    threadReviews,
    reactionOutbox,
    reviewUnitOfWork,
    setupUnitOfWork: new InMemorySetupUnitOfWork({
      loginTokens,
      settingsStore,
      githubCredentials,
      githubRepos,
    }),
    github,
    githubClient: () => github,
    shipDeps,
    timers,
    reviewLink: (recordId) => `https://ops.test/review/${encodeURIComponent(recordId)}`,
    tokenCipher: new FakeTokenCipher(),
    githubVerifier: new FakeGitHubVerifier(),
    eventDedupe: new InMemoryEventDedupe(clock),
    rateLimiter: new InMemoryRateLimiter(clock),
    attemptLimiter: new InMemoryAttemptLimiter(clock),
    throttle: new InMemoryThrottle(clock),
    wakeUp: new InMemoryWakeUp(clock),
    // Settings-backed port, as in the container: the source is called per use.
    reviewer: async () => ok(reviewer),
    llmProbe: async (target) => ({ kind: "ok", latencyMs: 1, model: target.model }),
    ...overrides,
  };
  return { ports, close: async () => {} };
}
