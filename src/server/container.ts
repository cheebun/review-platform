import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import {
  PgAppStateRepo,
  PgCredentialStore,
  PgReactionOutbox,
  PgReviewEventRepo,
  PgReviewJobRepo,
  PgReviewRecordRepo,
  PgSettingsRepo,
  PgThreadReviewIndex,
} from "../adapters/db";
import { PgSettingsStore } from "../adapters/db/pg-settings-store";
import { PgLoginTokenStore } from "../adapters/db/pg-login-token-store";
import { PgSetupUnitOfWork } from "../adapters/db/pg-setup-unit-of-work";
import { AesGcmTokenCipher, createSecretCiphers } from "../adapters/crypto/aes-gcm-token-cipher";
import { OctokitGitHub } from "../adapters/github/octokit-github";
import { OctokitGitHubVerifier } from "../adapters/github/octokit-github-verifier";
import { createAuth } from "../adapters/auth/auth";
import { createBetterAuthPort } from "../adapters/auth/better-auth-port";
import { createPgDb, redactUrl } from "../adapters/db/client";
import { notMigratedMessage } from "../adapters/db/db-errors";
import type { PgDb } from "../adapters/db/client";
import { createLlmProbe } from "../adapters/llm/ping";
import { createLlmProvidersFromSettings } from "../adapters/llm/settings-providers";
import { createRedis, redactUrls } from "../adapters/redis/client";
import { WebApiSlackVerifier } from "../adapters/slack/web-api-slack-verifier";
import type { ReviewUnitOfWork, Timers } from "../application/review/ports";
import { resolveGithubToken } from "../application/settings/view";
import type { ShipDeps } from "../application/ship/ship";
import type { Redis } from "../adapters/redis/client";
import { RedisEventDedupe } from "../adapters/redis/redis-event-dedupe";
import { RedisRateLimiter } from "../adapters/redis/redis-rate-limiter";
import { RedisAttemptLimiter } from "../adapters/redis/redis-attempt-limiter";
import { hashLoginToken, verifyLoginToken } from "../adapters/crypto/login-token-hash";
import { RedisThrottle } from "../adapters/redis/redis-throttle";
import { RedisWakeUp } from "../adapters/redis/redis-wake-up";
import { ConsoleLogger } from "../adapters/system/console-logger";
import { CryptoIdGenerator } from "../adapters/system/crypto-id-generator";
import { SystemClock } from "../adapters/system/system-clock";
import type { AuthPort } from "../ports/auth";
import type { AppStateRepo } from "../ports/app-state-repo";
import type { CredentialStore } from "../ports/credential-store";
import type { LoginTokenStore } from "../ports/login-token-store";
import type { LoginTokenHasher } from "../ports/login-token-hasher";
import type { AttemptLimiter } from "../ports/attempt-limiter";
import type { GitHubPort, MergeMethod } from "../ports/github";
import type { GitHubVerifier } from "../ports/github-verifier";
import { DEFAULT_REACTION_RETRY, type ReactionOutbox } from "../ports/reaction-outbox";
import type { ReviewRecordRepo } from "../ports/review-record-repo";
import type { SettingsStore } from "../ports/settings-store";
import type { SetupUnitOfWork } from "../ports/setup-unit-of-work";
import type { SlackVerifier } from "../ports/slack-verifier";
import type { ThreadReviewIndex } from "../ports/thread-review-index";
import type { ReviewEventRepo } from "../ports/review-event-repo";
import type { SettingsRepo } from "../ports/settings-repo";
import type { TokenCipher } from "../ports/token-cipher";
import type { EventDedupe } from "../ports/event-dedupe";
import type { RateLimiter } from "../ports/rate-limiter";
import type { ReviewJobRepo } from "../ports/review-job-repo";
import type { LlmProbe } from "../ports/llm-probe";
import type { ReviewerSource } from "../ports/reviewer";
import type { Clock, IdGenerator, Logger } from "../ports/system";
import type { Throttle } from "../ports/throttle";
import type { WakeUp } from "../ports/wake-up";
import type { Config } from "./config";
import { tokenScoped } from "./token-scoped";
import { PgReviewUnitOfWork } from "./workers/pg-review-unit-of-work";
import { realTimers } from "./workers/timers";

/**
 * Merge methods in order of preference; the adapter uses the first one the repository allows.
 * `merge` first: the legacy app always merged with a merge commit (src/lib/github.ts
 * `mergePullRequest`). Not configurable from env; a /settings choice can replace this later.
 */
export const MERGE_METHOD_PREFERENCE: readonly MergeMethod[] = ["merge", "squash", "rebase"];

const USER_AGENT = "agent-ops";

/** Every `GitHubPort` method, so the stored-token `github` port delegates all of them. */
const GITHUB_METHODS: Record<keyof GitHubPort, true> = {
  listOpenPullRequests: true,
  getPullRequest: true,
  getAuthenticatedLogin: true,
  getDiff: true,
  findCommentByMarker: true,
  createComment: true,
  findReviewByMarker: true,
  submitReview: true,
  getChecks: true,
  hasApproval: true,
  merge: true,
  listAccessibleRepos: true,
};

/** Every port the application can use. */
export interface Ports {
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  reviewJobs: ReviewJobRepo;
  appState: AppStateRepo;
  auth: AuthPort;
  /** The one GitHub token, encrypted (FR-GITHUB-03). Read it only via `resolveGithubToken`. */
  githubCredentials: CredentialStore;
  /** The GitHub repo list (FR-GITHUB-07): allowlist, Slack trigger set, `/review` picker. */
  githubRepos: SettingsRepo;
  /** Append-only settings and review history. */
  reviewEvents: ReviewEventRepo;
  /** Terminal review records (`review_result`), for /review, /merge and the ship gates. */
  reviewRecords: ReviewRecordRepo;
  /** The single login token's PBKDF2 hash (`login_token`); never the token itself. */
  loginTokens: LoginTokenStore;
  /** PBKDF2-HMAC-SHA256 hashing and constant-time checking of the login token. */
  loginTokenHasher: LoginTokenHasher;
  /** Encrypted Slack secrets and the review channels (FR-SLACKCFG). Keyed from BETTER_AUTH_SECRET. */
  settingsStore: SettingsStore;
  /** Checks a Slack value before it is stored (auth.test, app token, channel listing). */
  slackVerifier: SlackVerifier;
  /** Slack thread → review index (`slack_review_thread`). */
  threadReviews: ThreadReviewIndex;
  /** Status-emoji outbox (`reaction_outbox`, `slack_reaction`). */
  reactionOutbox: ReactionOutbox;
  /** The review writes that commit together, in one PG transaction. */
  reviewUnitOfWork: ReviewUnitOfWork;
  /** First-run setup's writes (login token, owner user, settings): one PG transaction. */
  setupUnitOfWork: SetupUnitOfWork;
  /** GitHub as the stored token, read per call. `not_configured github` without one. */
  github: GitHubPort;
  /** A `GitHubPort` bound to `token`, merging by `MERGE_METHOD_PREFERENCE`. */
  githubClient: (token: string) => GitHubPort;
  /** The ship use-case deps over `github`. */
  shipDeps: (github: GitHubPort) => ShipDeps;
  timers: Timers;
  /** The `/review/$reviewId` URL under BETTER_AUTH_URL, for Slack result replies. */
  reviewLink: (recordId: string) => string;
  /** AES-256-GCM keyed from BETTER_AUTH_SECRET. */
  tokenCipher: TokenCipher;
  /** Read-only GitHub token and repo checks. */
  githubVerifier: GitHubVerifier;
  eventDedupe: EventDedupe;
  rateLimiter: RateLimiter;
  /** Failed-attempt counter with lockout, per client IP for login (FR-AUTH-02). */
  attemptLimiter: AttemptLimiter;
  throttle: Throttle;
  wakeUp: WakeUp;
  /*
   * The reviewer, built per call from the stored Anthropic settings (FR-LLMCFG-01), otherwise
   * `not_configured llm` (503). No restart is needed.
   */
  reviewer: ReviewerSource;
  /** The save-time LLM check (`llm:ping`), with a timeout. Never throws. */
  llmProbe: LlmProbe;
}

export interface Container {
  ports: Ports;
  /** Closes every connection this container opened, in reverse order. Idempotent. */
  close(): Promise<void>;
}

/** Connection factories. Second-level override so tests can observe or stub connecting. */
export interface ConnectionFactories {
  createPgDb: typeof createPgDb;
  createRedis: typeof createRedis;
  /** Builds the Anthropic SDK client. Constructing a client opens no connection. */
  createAnthropic?: (options: ClientOptions) => Anthropic;
}

const DEFAULT_FACTORIES: ConnectionFactories = {
  createPgDb,
  createRedis,
  createAnthropic: (options) => new Anthropic(options),
};

const DB_PORTS = [
  "reviewJobs",
  "appState",
  "auth",
  "githubCredentials",
  "githubRepos",
  "reviewEvents",
  "reviewRecords",
  "settingsStore",
  "threadReviews",
  "reactionOutbox",
  "reviewUnitOfWork",
  "loginTokens",
  "setupUnitOfWork",
] as const;
const REDIS_PORTS = ["eventDedupe", "rateLimiter", "attemptLimiter", "throttle", "wakeUp"] as const;

function scrub(error: unknown, config: Config): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactUrls(redactUrl(redactUrl(text, config.databaseUrl), config.redisUrl));
}

/**
 * Composition root. Pure function of `config` and `overrides`: it never reads `process.env`.
 *
 * Async and eager: a connection is opened at boot, but only when at least one port that needs
 * it is not overridden. A bad URL or unreachable server therefore fails the process at startup
 * (fail closed) instead of on the first request. Startup errors are redacted and carry no URL.
 */
export async function createContainer(
  config: Config,
  overrides: Partial<Ports> = {},
  factories: ConnectionFactories = DEFAULT_FACTORIES,
): Promise<Container> {
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new CryptoIdGenerator();
  const logger = overrides.logger ?? new ConsoleLogger({ clock });

  /** Close callbacks in open order; run reversed. */
  const closers: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Only the first call reports a failure; later calls just wait for it and resolve.
    if (closing) return closing.catch(() => {});
    closing = (async () => {
      const errors: unknown[] = [];
      for (const fn of closers.splice(0).toReversed()) {
        try {
          await fn();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new Error(
          `Container close failed: ${errors.map((e) => scrub(e, config)).join("; ")}`,
        );
      }
    })();
    return closing;
  };

  try {
    const needsDb = DB_PORTS.some((k) => overrides[k] === undefined);
    const needsRedis = REDIS_PORTS.some((k) => overrides[k] === undefined);

    let pg: PgDb | undefined;
    if (needsDb) {
      pg = factories.createPgDb({
        url: config.databaseUrl,
        ...(config.databaseSearchPath ? { searchPath: config.databaseSearchPath } : {}),
      });
      closers.push(() => pg!.close());
      // The pool is lazy; ping so an unreachable database fails at boot.
      await pg.db.execute(sql`SELECT 1`);
      // A reachable but unmigrated schema would otherwise fail on the first request with a raw
      // "Failed query" (e.g. a new DATABASE_SEARCH_PATH). `app_state` is created by migration 0.
      await pg.db.execute(sql`SELECT 1 FROM app_state LIMIT 1`);
    }

    let redis: Redis | undefined;
    if (needsRedis) {
      redis = await factories.createRedis({
        url: config.redisUrl,
        keyPrefix: config.redisKeyPrefix,
        logger,
      });
      closers.push(() => redis!.close());
    }

    const db = pg?.db;
    const rd = redis;
    const appState = overrides.appState ?? new PgAppStateRepo(db!, clock);
    const reviewJobs = overrides.reviewJobs ?? new PgReviewJobRepo(db!, clock);
    const reviewEvents = overrides.reviewEvents ?? new PgReviewEventRepo(db!);
    const reviewRecords = overrides.reviewRecords ?? new PgReviewRecordRepo(db!);
    const threadReviews = overrides.threadReviews ?? new PgThreadReviewIndex(db!, clock);
    const reviewUnitOfWork =
      overrides.reviewUnitOfWork ?? new PgReviewUnitOfWork(db!, clock, logger);
    const githubCredentials = overrides.githubCredentials ?? new PgCredentialStore(db!);
    const githubRepos = overrides.githubRepos ?? new PgSettingsRepo(db!);
    const loginTokens = overrides.loginTokens ?? new PgLoginTokenStore(db!, clock);
    const tokenCipher =
      overrides.tokenCipher ?? new AesGcmTokenCipher({ secret: config.auth.secret });
    const secretCiphers = createSecretCiphers({ secret: config.auth.secret });
    const settingsStore = overrides.settingsStore ?? new PgSettingsStore(db!, secretCiphers);
    const clientFactory = factories.createAnthropic ?? DEFAULT_FACTORIES.createAnthropic;
    // Built only when the reviewer is not overridden.
    const llm = overrides.reviewer
      ? undefined
      : createLlmProvidersFromSettings(settingsStore, { logger, clientFactory });
    const timers = overrides.timers ?? realTimers;
    const githubClient =
      overrides.githubClient ??
      ((token: string): GitHubPort =>
        new OctokitGitHub({ token, userAgent: USER_AGENT, mergeMethods: MERGE_METHOD_PREFERENCE }));
    const github =
      overrides.github ??
      tokenScoped<GitHubPort>({
        service: "github",
        token: () => resolveGithubToken({ githubCredentials, tokenCipher }),
        build: githubClient,
        methods: GITHUB_METHODS,
      });
    const shipDeps =
      overrides.shipDeps ??
      ((gh: GitHubPort): ShipDeps => ({
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
        // No `mergeMethod`: a pinned method would bypass the adapter's choice of the first
        // `MERGE_METHOD_PREFERENCE` entry the repository allows.
      }));
    const reviewLink =
      overrides.reviewLink ??
      ((recordId: string) =>
        new URL(`/review/${encodeURIComponent(recordId)}`, config.auth.url).toString());
    const ports: Ports = {
      clock,
      ids,
      logger,
      reviewJobs,
      appState,
      auth:
        overrides.auth ??
        createBetterAuthPort(
          createAuth({ db: db!, secret: config.auth.secret, baseURL: config.auth.url }),
          { db: db!, clock },
        ),
      githubCredentials,
      githubRepos,
      reviewEvents,
      reviewRecords,
      loginTokens,
      loginTokenHasher: overrides.loginTokenHasher ?? {
        hash: hashLoginToken,
        verify: verifyLoginToken,
      },
      settingsStore,
      slackVerifier: overrides.slackVerifier ?? new WebApiSlackVerifier(),
      threadReviews,
      reactionOutbox:
        overrides.reactionOutbox ??
        new PgReactionOutbox(db!, clock, { ...DEFAULT_REACTION_RETRY, jitter: Math.random }),
      reviewUnitOfWork,
      setupUnitOfWork:
        overrides.setupUnitOfWork ?? new PgSetupUnitOfWork(db!, secretCiphers, clock, ids),
      github,
      githubClient,
      shipDeps,
      timers,
      reviewLink,
      tokenCipher,
      githubVerifier:
        overrides.githubVerifier ?? new OctokitGitHubVerifier({ userAgent: USER_AGENT }),
      eventDedupe: overrides.eventDedupe ?? new RedisEventDedupe(rd!),
      rateLimiter: overrides.rateLimiter ?? new RedisRateLimiter(rd!, clock, ids),
      attemptLimiter: overrides.attemptLimiter ?? new RedisAttemptLimiter(rd!),
      throttle: overrides.throttle ?? new RedisThrottle(rd!),
      wakeUp: overrides.wakeUp ?? new RedisWakeUp(rd!, logger),
      reviewer: overrides.reviewer ?? llm!.reviewer,
      llmProbe: overrides.llmProbe ?? createLlmProbe({ logger, clientFactory }),
    };
    return { ports, close };
  } catch (error) {
    await close().catch(() => {});
    // No `cause`: the original error may embed a connection string.
    throw new Error(
      `Container startup failed: ${notMigratedMessage(error) ?? scrub(error, config)}`,
    );
  }
}
