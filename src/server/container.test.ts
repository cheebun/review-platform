import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { PgDb, createPgDb as realCreatePgDb } from "../adapters/db/client";
import type { Redis, createRedis as realCreateRedis } from "../adapters/redis/client";
import { FakeClock } from "../testing/fakes/fake-clock";
import { InMemoryEventDedupe } from "../testing/fakes/in-memory-event-dedupe";
import { InMemoryRateLimiter } from "../testing/fakes/in-memory-rate-limiter";
import { InMemoryAttemptLimiter } from "../testing/fakes/in-memory-attempt-limiter";
import { FakeLoginTokenHasher } from "../testing/fakes/fake-login-token-hasher";
import { RedisAttemptLimiter } from "../adapters/redis/redis-attempt-limiter";
import { LOGIN_TOKEN_HASH_PREFIX } from "../ports/login-token-store";
import { InMemoryThrottle } from "../testing/fakes/in-memory-throttle";
import { InMemoryWakeUp } from "../testing/fakes/in-memory-wake-up";
import { InMemoryAppStateRepo } from "../testing/fakes/in-memory-app-state-repo";
import { InMemoryReviewJobRepo } from "../testing/fakes/in-memory-review-job-repo";
import { FakeAuth } from "../testing/fakes/fake-auth";
import { InMemoryCredentialStore } from "../testing/fakes/in-memory-credential-store";
import { InMemoryLoginTokenStore } from "../testing/fakes/in-memory-login-token-store";
import { InMemoryReviewEventRepo } from "../testing/fakes/in-memory-review-event-repo";
import { InMemorySettingsRepo } from "../testing/fakes/in-memory-settings-repo";
import { AesGcmTokenCipher } from "../adapters/crypto/aes-gcm-token-cipher";
import { OctokitGitHubVerifier } from "../adapters/github/octokit-github-verifier";
import { MemoryLogger } from "../testing/fakes/memory-logger";
import { SequenceIdGenerator } from "../testing/fakes/sequence-id-generator";
import { FakeReviewer } from "../testing/fakes/fake-reviewer";
import { PgReviewRecordRepo } from "../adapters/db/pg-review-record-repo";
import { PgSettingsStore } from "../adapters/db/pg-settings-store";
import { PgLoginTokenStore } from "../adapters/db/pg-login-token-store";
import { PgThreadReviewIndex } from "../adapters/db/pg-thread-review-index";
import { PgReactionOutbox } from "../adapters/db/pg-reaction-outbox";
import { OctokitGitHub } from "../adapters/github/octokit-github";
import { AnthropicReviewer } from "../adapters/llm/anthropic-reviewer";
import { WebApiSlackVerifier } from "../adapters/slack/web-api-slack-verifier";
import { InMemoryReviewUnitOfWork } from "../application/review/testing";
import { DEFAULT_REACTION_RETRY } from "../ports/reaction-outbox";
import { FakeGitHub } from "../testing/fakes/fake-github";
import { InMemoryReactionOutbox } from "../testing/fakes/in-memory-reaction-outbox";
import { InMemoryReviewRecordRepo } from "../testing/fakes/in-memory-review-record-repo";
import { InMemorySetupUnitOfWork } from "../testing/fakes/in-memory-setup-unit-of-work";
import { InMemorySettingsStore } from "../testing/fakes/in-memory-settings-store";
import { InMemoryThreadReviewIndex } from "../testing/fakes/in-memory-thread-review-index";
import { aSettingsEvent } from "../testing/contracts/harness";
import { aStoredRepo } from "../testing/contracts/settings-repo.contract";
import { PgSetupUnitOfWork } from "../adapters/db/pg-setup-unit-of-work";
import { PgReviewUnitOfWork } from "./workers/pg-review-unit-of-work";
import { realTimers } from "./workers/timers";
import { createTestContainer } from "../testing/container";
import { aNewReviewJob } from "../testing/builders/review-job";
import { ok } from "../domain/shared/result";
import { loadConfig } from "./config";
import { createContainer, MERGE_METHOD_PREFERENCE, type Ports } from "./container";

const SECRET_URL = "postgresql://user:hunter2pw@db.example.com:5432/app";
const REDIS_SECRET_URL = "redis://:redispw@cache.example.com:6379";

const config = loadConfig({
  DATABASE_URL: SECRET_URL,
  REDIS_URL: REDIS_SECRET_URL,
  REDIS_KEY_PREFIX: "pfx:",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
});

/** Fakes for every port that needs Postgres. */
function dbPorts(
  clock: FakeClock,
): Pick<
  Ports,
  | "reviewJobs"
  | "appState"
  | "auth"
  | "githubCredentials"
  | "githubRepos"
  | "reviewEvents"
  | "reviewRecords"
  | "settingsStore"
  | "threadReviews"
  | "reactionOutbox"
  | "reviewUnitOfWork"
  | "loginTokens"
  | "setupUnitOfWork"
> {
  const reviewEvents = new InMemoryReviewEventRepo();
  const reviewJobs = new InMemoryReviewJobRepo(clock);
  const reviewRecords = new InMemoryReviewRecordRepo();
  const threadReviews = new InMemoryThreadReviewIndex(clock);
  const reactionOutbox = new InMemoryReactionOutbox(clock, {
    ...DEFAULT_REACTION_RETRY,
    jitter: () => 0,
  });
  const githubCredentials = new InMemoryCredentialStore();
  const githubRepos = new InMemorySettingsRepo();
  const settingsStore = new InMemorySettingsStore(reviewEvents);
  const loginTokens = new InMemoryLoginTokenStore(clock);
  return {
    githubCredentials,
    githubRepos,
    reviewEvents,
    reviewRecords,
    settingsStore,
    threadReviews,
    reactionOutbox,
    reviewUnitOfWork: new InMemoryReviewUnitOfWork({
      jobs: reviewJobs,
      records: reviewRecords,
      events: reviewEvents,
      threads: threadReviews,
      outbox: reactionOutbox,
      clock,
    }),
    auth: new FakeAuth(),
    reviewJobs,
    appState: new InMemoryAppStateRepo(clock),
    loginTokens,
    setupUnitOfWork: new InMemorySetupUnitOfWork({
      loginTokens,
      settingsStore,
      githubCredentials,
      githubRepos,
    }),
  };
}

/** Fakes for every port that needs Redis. */
function redisPorts(
  clock: FakeClock,
): Pick<Ports, "eventDedupe" | "rateLimiter" | "attemptLimiter" | "throttle" | "wakeUp"> {
  return {
    eventDedupe: new InMemoryEventDedupe(clock),
    rateLimiter: new InMemoryRateLimiter(clock),
    attemptLimiter: new InMemoryAttemptLimiter(clock),
    throttle: new InMemoryThrottle(clock),
    wakeUp: new InMemoryWakeUp(clock),
  };
}

function stubs(order: string[] = []) {
  const pg: PgDb = {
    db: { execute: vi.fn(async () => [{ ok: 1 }]) } as never,
    poolSize: 1,
    close: vi.fn(async () => void order.push("pg")),
  };
  const redis = {
    client: {},
    key: (n: string) => n,
    duplicate: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(async () => void order.push("redis")),
  } as unknown as Redis;
  const createPgDb = vi.fn((_o: Parameters<typeof realCreatePgDb>[0]) => pg);
  const createRedis = vi.fn(async (_o: Parameters<typeof realCreateRedis>[0]) => redis);
  return { pg, redis, createPgDb, createRedis, factories: { createPgDb, createRedis } };
}

/** Ports of removed features; neither container may expose them. */
const REMOVED_PORT_KEYS = [
  "readState",
  "digestMessages",
  "digests",
  "lock",
  "summarizer",
  "slack",
  "jira",
  "jiraVerifier",
  "breakdowner",
] as const;

describe("Ports has no keys of removed features", () => {
  it("createContainer", async () => {
    const c = await createContainer(config, {}, stubs().factories);
    for (const key of REMOVED_PORT_KEYS) expect(c.ports).not.toHaveProperty(key);
    await c.close();
  });

  it("createTestContainer", () => {
    const { ports } = createTestContainer();
    for (const key of REMOVED_PORT_KEYS) expect(ports).not.toHaveProperty(key);
  });
});

describe("createContainer", () => {
  it("provides default system ports and the config", async () => {
    const s = stubs();
    const c = await createContainer(config, {}, s.factories);
    expect(c.ports.clock.now()).toBeInstanceOf(Date);
    expect(typeof c.ports.ids.uuid()).toBe("string");
    expect(typeof c.ports.logger.info).toBe("function");
    expect(c.ports.reviewJobs).toBeDefined();
    await c.close();
  });

  it("provides an auth port built from the database and config", async () => {
    const s = stubs();
    const c = await createContainer(config, {}, s.factories);
    expect(typeof c.ports.auth.getSessionActor).toBe("function");
    expect(typeof c.ports.auth.handler).toBe("function");
    expect(typeof c.ports.auth.signInOwner).toBe("function");
    expect(typeof c.ports.auth.rotateLoginToken).toBe("function");
    await c.close();
  });

  it("provides the login token hasher (PBKDF2) and the Redis attempt limiter", async () => {
    const s = stubs();
    const c = await createContainer(config, {}, s.factories);
    expect(c.ports.attemptLimiter).toBeInstanceOf(RedisAttemptLimiter);
    const hash = await c.ports.loginTokenHasher.hash("secret-token");
    expect(hash.startsWith(LOGIN_TOKEN_HASH_PREFIX)).toBe(true);
    expect(await c.ports.loginTokenHasher.verify("secret-token", hash)).toBe(true);
    expect(await c.ports.loginTokenHasher.verify("other-token", hash)).toBe(false);
    await c.close();
  });

  it("provides the GitHub settings ports: PG stores, AES-GCM cipher, read-only verifier", async () => {
    const s = stubs();
    const c = await createContainer(config, {}, s.factories);
    expect(c.ports.githubCredentials).toBeDefined();
    expect(c.ports.githubRepos).toBeDefined();
    expect(c.ports.reviewEvents).toBeDefined();
    expect(c.ports.tokenCipher).toBeInstanceOf(AesGcmTokenCipher);
    expect(c.ports.githubVerifier).toBeInstanceOf(OctokitGitHubVerifier);
    // The cipher is keyed by BETTER_AUTH_SECRET: a cipher with the same secret decrypts.
    const enc = c.ports.tokenCipher.encrypt("x".repeat(30));
    expect(new AesGcmTokenCipher({ secret: "a".repeat(32) }).decrypt(enc)).toEqual({
      ok: true,
      value: "x".repeat(30),
    });
    await c.close();
  });

  it("an auth override replaces the real one", async () => {
    const auth = new FakeAuth();
    const s = stubs();
    const c = await createContainer(config, { auth }, s.factories);
    expect(c.ports.auth).toBe(auth);
    await c.close();
  });

  it("passes DATABASE_SEARCH_PATH to the pool", async () => {
    const s = stubs();
    const withPath = loadConfig({
      DATABASE_URL: SECRET_URL,
      REDIS_URL: REDIS_SECRET_URL,
      BETTER_AUTH_SECRET: "a".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
      DATABASE_SEARCH_PATH: "test_x_1",
    });
    await (await createContainer(withPath, {}, s.factories)).close();
    expect(s.createPgDb.mock.calls[0]![0]).toMatchObject({ searchPath: "test_x_1" });
  });

  it("overrides replace defaults", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const ids = new SequenceIdGenerator();
    const logger = new MemoryLogger();
    const s = stubs();
    const c = await createContainer(config, { clock, ids, logger }, s.factories);
    expect(c.ports.clock).toBe(clock);
    expect(c.ports.ids).toBe(ids);
    expect(c.ports.logger).toBe(logger);
    await c.close();
  });

  it("opens no connection when every port is overridden", async () => {
    const clock = new FakeClock();
    const s = stubs();
    const c = await createContainer(
      config,
      { clock, ...dbPorts(clock), ...redisPorts(clock) },
      s.factories,
    );
    expect(s.createPgDb).not.toHaveBeenCalled();
    expect(s.createRedis).not.toHaveBeenCalled();
    await c.close();
    expect(s.pg.close).not.toHaveBeenCalled();
    expect(s.redis.close).not.toHaveBeenCalled();
  });

  it("opens only Postgres when all Redis ports are overridden, and only Redis in the reverse case", async () => {
    const clock = new FakeClock();
    const a = stubs();
    await (await createContainer(config, { clock, ...redisPorts(clock) }, a.factories)).close();
    expect(a.createPgDb).toHaveBeenCalledTimes(1);
    expect(a.createRedis).not.toHaveBeenCalled();

    const b = stubs();
    await (await createContainer(config, { clock, ...dbPorts(clock) }, b.factories)).close();
    expect(b.createPgDb).not.toHaveBeenCalled();
    expect(b.createRedis).toHaveBeenCalledTimes(1);
  });

  it("opens each connection once and passes URL and key prefix from config", async () => {
    const s = stubs();
    const c = await createContainer(config, {}, s.factories);
    expect(s.createPgDb).toHaveBeenCalledTimes(1);
    expect(s.createRedis).toHaveBeenCalledTimes(1);
    expect(s.createPgDb.mock.calls[0]![0]).toMatchObject({ url: SECRET_URL });
    expect(s.createRedis.mock.calls[0]![0]).toMatchObject({
      url: REDIS_SECRET_URL,
      keyPrefix: "pfx:",
    });
    await c.close();
  });

  it("close() closes in reverse order, exactly once, and is idempotent", async () => {
    const order: string[] = [];
    const s = stubs(order);
    const c = await createContainer(config, {}, s.factories);
    await c.close();
    await expect(c.close()).resolves.toBeUndefined();
    expect(order).toEqual(["redis", "pg"]);
    expect(s.pg.close).toHaveBeenCalledTimes(1);
    expect(s.redis.close).toHaveBeenCalledTimes(1);
  });

  it("close() still closes the rest when one close throws, then rejects once", async () => {
    const s = stubs();
    (s.redis.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const c = await createContainer(config, {}, s.factories);
    await expect(c.close()).rejects.toThrow();
    expect(s.pg.close).toHaveBeenCalledTimes(1);
    await expect(c.close()).resolves.toBeUndefined();
  });

  it("startup failure closes what already opened and leaks no URL", async () => {
    const order: string[] = [];
    const s = stubs(order);
    s.createRedis.mockRejectedValueOnce(
      new Error(`connect failed for ${REDIS_SECRET_URL} password redispw`),
    );
    const err = await createContainer(config, {}, s.factories).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const text = `${(err as Error).message} ${(err as Error).stack ?? ""} ${String((err as Error).cause ?? "")}`;
    expect(text).not.toContain("redispw");
    expect(text).not.toContain("hunter2pw");
    expect(text).not.toContain("redis://");
    expect(order).toEqual(["pg"]);
  });

  it("Postgres startup failure (unreachable) is redacted and closes the pool", async () => {
    const s = stubs();
    (s.pg.db.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(`ECONNREFUSED ${SECRET_URL}`),
    );
    const err = await createContainer(config, {}, s.factories).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("hunter2pw");
    expect(s.pg.close).toHaveBeenCalledTimes(1);
    expect(s.createRedis).not.toHaveBeenCalled();
  });
});

const repoAdded = () => aSettingsEvent("github_repo_added", { repo: "acme/web" });

describe("createContainer: review, merge and Slack ports (stage 3)", () => {
  it("wires the PG stores, the Slack verifier, the unit of work and the timers", async () => {
    const c = await createContainer(config, {}, stubs().factories);
    expect(c.ports.reviewRecords).toBeInstanceOf(PgReviewRecordRepo);
    expect(c.ports.settingsStore).toBeInstanceOf(PgSettingsStore);
    expect(c.ports.loginTokens).toBeInstanceOf(PgLoginTokenStore);
    expect(c.ports.threadReviews).toBeInstanceOf(PgThreadReviewIndex);
    expect(c.ports.reactionOutbox).toBeInstanceOf(PgReactionOutbox);
    expect(c.ports.reviewUnitOfWork).toBeInstanceOf(PgReviewUnitOfWork);
    expect(c.ports.setupUnitOfWork).toBeInstanceOf(PgSetupUnitOfWork);
    expect(c.ports.slackVerifier).toBeInstanceOf(WebApiSlackVerifier);
    expect(c.ports.timers).toBe(realTimers);
    await c.close();
  });

  it("links reviews under BETTER_AUTH_URL, with the id escaped", async () => {
    const c = await createContainer(config, {}, stubs().factories);
    expect(c.ports.reviewLink("rv 1/x")).toBe("http://localhost:3000/review/rv%201%2Fx");
    await c.close();
  });

  it("merges with the legacy method first, then the other two (src/lib/github.ts)", async () => {
    expect(MERGE_METHOD_PREFERENCE).toEqual(["merge", "squash", "rebase"]);
    const c = await createContainer(config, {}, stubs().factories);
    const gh = c.ports.githubClient("token-for-test");
    expect(gh).toBeInstanceOf(OctokitGitHub);
    expect(gh).toHaveProperty("mergeMethods", MERGE_METHOD_PREFERENCE);
    await c.close();
  });

  it("shipDeps: the full ShipDeps over the given GitHub, allowlisted by the repo list", async () => {
    const clock = new FakeClock();
    const ports = { clock, ...dbPorts(clock), ...redisPorts(clock) };
    const added = await ports.githubRepos.addRepo(aStoredRepo("acme/web", 1), {
      max: 50,
      event: repoAdded,
    });
    expect(added.ok).toBe(true);
    const c = await createContainer(config, ports, stubs().factories);
    const github = new FakeGitHub();
    const deps = c.ports.shipDeps(github);
    expect(deps).toMatchObject({
      github,
      records: ports.reviewRecords,
      events: ports.reviewEvents,
      jobs: ports.reviewJobs,
      threads: ports.threadReviews,
      uow: ports.reviewUnitOfWork,
      clock,
      timers: realTimers,
    });
    // The adapter picks the first preferred method the repository allows.
    expect(deps.mergeMethod).toBeUndefined();
    expect(await deps.repoList()).toEqual(["acme/web"]);
    await c.close();
  });

  it("github reads the stored token per call: none stored is not_configured", async () => {
    const clock = new FakeClock();
    const c = await createContainer(
      config,
      { clock, ...dbPorts(clock), ...redisPorts(clock) },
      stubs().factories,
    );
    expect(await c.ports.github.getAuthenticatedLogin()).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "github" },
    });
    await c.close();
  });
});

describe("createContainer: migration guard", () => {
  it("says the database is not migrated when a required table is missing", async () => {
    const s = stubs();
    const exec = s.pg.db.execute as ReturnType<typeof vi.fn>;
    exec.mockResolvedValueOnce([{ ok: 1 }]); // SELECT 1 ping
    exec.mockRejectedValueOnce(
      new Error('Failed query: select 1 from "app_state"', {
        cause: Object.assign(new Error('relation "app_state" does not exist'), { code: "42P01" }),
      }),
    );
    const err = await createContainer(config, {}, s.factories).catch((e: unknown) => e);
    expect((err as Error).message).toContain("database not migrated: run pnpm db:migrate");
    expect((err as Error).message).not.toContain("Failed query");
    expect(s.pg.close).toHaveBeenCalledTimes(1);
  });
});

describe("createContainer LLM ports (read from /settings on every call)", () => {
  const at = new Date("2026-11-04T03:00:00.000Z");
  const overrides = () => {
    const clock = new FakeClock();
    return { clock, ...dbPorts(clock), ...redisPorts(clock) };
  };
  const anthropicFactory = () =>
    vi.fn((o: ConstructorParameters<typeof Anthropic>[0]) => new Anthropic(o));
  // Test sentinels, never real credentials.
  async function save(
    store: Ports["settingsStore"],
    kind: "anthropic_api_key" | "openai_api_key",
    value: string,
    values: Parameters<Ports["settingsStore"]["saveBundle"]>[0]["values"] = {},
  ) {
    await store.saveBundle(
      {
        secrets: {
          [kind]: { value, savedAt: at, savedByUserId: "u1", verifiedAt: at, testResult: null },
        },
        values,
      },
      { at, by: "u1", event: () => aSettingsEvent("settings_value_saved") },
    );
  }

  it("answers not_configured llm while the store holds no provider, and builds no client", async () => {
    const createAnthropic = anthropicFactory();
    const c = await createContainer(config, overrides(), {
      ...stubs().factories,
      createAnthropic,
    });
    const notConfigured = { ok: false, error: { kind: "not_configured", feature: "llm" } };
    expect(await c.ports.reviewer()).toEqual(notConfigured);
    expect(createAnthropic).not.toHaveBeenCalled();
    await c.close();
  });

  it("builds the Anthropic client from the stored key and base URL, with no restart", async () => {
    const createAnthropic = anthropicFactory();
    const o = overrides();
    const c = await createContainer(config, o, { ...stubs().factories, createAnthropic });
    expect((await c.ports.reviewer()).ok).toBe(false);
    await save(o.settingsStore, "anthropic_api_key", "key-for-test", {
      anthropic_base_url: "https://llm.example.test/",
    });
    const reviewer = await c.ports.reviewer();
    expect(reviewer.ok && reviewer.value).toBeInstanceOf(AnthropicReviewer);
    expect(createAnthropic).toHaveBeenCalled();
    for (const [opts] of createAnthropic.mock.calls) {
      expect(opts).toMatchObject({
        baseURL: "https://llm.example.test",
        apiKey: "key-for-test",
        defaultHeaders: { Authorization: null, "x-api-key": "key-for-test" },
      });
    }
    await c.close();
  });

  it("obsolete OpenAI records remain inactive; Anthropic serves the remaining ports", async () => {
    const o = overrides();
    const c = await createContainer(config, o, stubs().factories);
    await save(o.settingsStore, "openai_api_key", "openai-key-for-test");
    const openai = await c.ports.reviewer();
    expect(openai).toMatchObject({ ok: false, error: { kind: "not_configured" } });
    await save(o.settingsStore, "anthropic_api_key", "key-for-test");
    const both = await c.ports.reviewer();
    expect(both.ok && both.value).toBeInstanceOf(AnthropicReviewer);
    await c.close();
  });

  it("has the independent connection probe", async () => {
    const c = await createContainer(config, overrides(), stubs().factories);
    expect(typeof c.ports.llmProbe).toBe("function");
    await c.close();
  });

  it("overrides replace the LLM ports", async () => {
    const reviewer = async () => ok(new FakeReviewer());
    const c = await createContainer(config, { ...overrides(), reviewer }, stubs().factories);
    expect(c.ports.reviewer).toBe(reviewer);
    await c.close();
  });
});

describe("createTestContainer", () => {
  it("uses the LLM fakes", async () => {
    const c = createTestContainer();
    expect(c.ports).not.toHaveProperty("jira");
    expect(c.ports).not.toHaveProperty("jiraVerifier");
    expect(c.ports).not.toHaveProperty("breakdowner");
    const reviewer = await c.ports.reviewer();
    expect(reviewer.ok && reviewer.value).toBeInstanceOf(FakeReviewer);
  });

  it("returns working fakes with deterministic clock and ids", async () => {
    const c = createTestContainer();
    expect(c.ports.ids.uuid()).toBe(new SequenceIdGenerator().uuid());
    const created = await c.ports.reviewJobs.create(aNewReviewJob({ id: "j1" }));
    expect(created.ok).toBe(true);
    const claimed = await c.ports.reviewJobs.claimNext({ owner: "w", leaseMs: 1000 });
    expect(claimed?.id).toBe("j1");
    expect(claimed?.state).toBe("running");
    expect(await c.ports.eventDedupe.claim("e", 1000)).toBe(true);
    expect(await c.ports.eventDedupe.claim("e", 1000)).toBe(false);
    await c.close();
    await c.close();
  });

  it("provides a fake auth port with no session, and fast login token fakes", async () => {
    const c = createTestContainer();
    expect(c.ports.auth).toBeInstanceOf(FakeAuth);
    expect(c.ports.attemptLimiter).toBeInstanceOf(InMemoryAttemptLimiter);
    expect(c.ports.loginTokenHasher).toBeInstanceOf(FakeLoginTokenHasher);
    expect(await c.ports.auth.getSessionActor(new Headers())).toBeNull();
  });

  it("provides an uninitialized in-memory login token store", async () => {
    const c = createTestContainer();
    expect(c.ports.loginTokens).toBeInstanceOf(InMemoryLoginTokenStore);
    expect(await c.ports.loginTokens.isInitialized()).toBe(false);
  });

  it("accepts overrides", () => {
    const clock = new FakeClock(new Date("2030-01-01T00:00:00.000Z"));
    expect(createTestContainer({ clock }).ports.clock).toBe(clock);
  });
});
