import { beforeEach, describe, expect, it } from "vitest";
import { ANTHROPIC_PROBE_MODEL, type LlmTarget } from "../../domain/settings/llm-settings";
import { createTestContainer } from "../../testing/container";
import type { FakeAuth } from "../../testing/fakes/fake-auth";
import type { FakeGitHub } from "../../testing/fakes/fake-github";
import type { FakeGitHubVerifier } from "../../testing/fakes/fake-github-verifier";
import type { FakeSlackVerifier } from "../../testing/fakes/fake-slack-verifier";
import type { InMemorySetupUnitOfWork } from "../../testing/fakes/in-memory-setup-unit-of-work";
import type { MemoryLogger } from "../../testing/fakes/memory-logger";
import { ANTHROPIC_KEY } from "../settings/llm-testing";
import { SIGNING_SECRET, USER_TOKEN } from "../settings/slack-testing";
import { TOKEN as GITHUB_TOKEN } from "../settings/testing";
import {
  finishSetup,
  getSetupSections,
  listSetupGithubRepos,
  SETUP_ATTEMPT_POLICY,
  setupAttemptKey,
  testSetupAnthropic,
  testSetupSlack,
  type FinishSetupInput,
} from "./setup";

const LOGIN = "correct horse battery";
const IP = "203.0.113.9";
const headers = new Headers();

let ports: ReturnType<typeof createTestContainer>["ports"];
let auth: FakeAuth;
let logger: MemoryLogger;
let verifier: FakeGitHubVerifier;
let slack: FakeSlackVerifier;
let uow: InMemorySetupUnitOfWork;
let probes: LlmTarget[];

beforeEach(() => {
  probes = [];
  const c = createTestContainer({
    llmProbe: async (target) => {
      probes.push(target);
      return { kind: "ok", latencyMs: 3, model: target.model };
    },
  });
  ports = c.ports;
  auth = ports.auth as FakeAuth;
  logger = ports.logger as MemoryLogger;
  verifier = ports.githubVerifier as FakeGitHubVerifier;
  slack = ports.slackVerifier as FakeSlackVerifier;
  uow = ports.setupUnitOfWork as InMemorySetupUnitOfWork;
  verifier.acceptToken(GITHUB_TOKEN).grantRepo(GITHUB_TOKEN, "acme/api");
  slack.userToken(USER_TOKEN);
});

const full = (): FinishSetupInput => ({
  token: LOGIN,
  confirm: LOGIN,
  anthropic: { apiKey: ANTHROPIC_KEY },
  github: { token: GITHUB_TOKEN, repos: ["acme/api"] },
  slack: { userToken: USER_TOKEN, signingSecret: SIGNING_SECRET },
});

const finish = (input: FinishSetupInput = full()) => finishSetup(ports, input, IP, headers);

async function nothingWritten() {
  expect(await ports.loginTokens.isInitialized()).toBe(false);
  expect(uow.runs).toBe(0);
  expect(auth.signIns).toHaveLength(0);
  expect((await ports.settingsStore.getSecret("anthropic_api_key")).state).toBe("not_configured");
  expect(await ports.githubCredentials.get()).toBeNull();
  expect(await ports.githubRepos.listRepos()).toEqual([]);
}

const seedSlack = () =>
  ports.settingsStore.saveSecret(
    "slack_user_token",
    {
      value: USER_TOKEN,
      savedAt: new Date(0),
      savedByUserId: "earlier",
      verifiedAt: null,
      testResult: null,
    },
    () => ({
      id: "e0",
      type: "slack_secret_saved",
      actor: { kind: "user", id: "earlier" },
      at: new Date(0),
      source: "web",
      detail: {},
    }),
  );

describe("finishSetup", () => {
  it("token only: stores the hash in one transaction, signs the owner in, writes no settings", async () => {
    expect(await finish({ token: LOGIN, confirm: LOGIN })).toEqual({ ok: true, value: undefined });
    expect(await ports.loginTokens.isInitialized()).toBe(true);
    expect(uow.runs).toBe(1);
    expect(auth.signIns).toEqual([headers]);
    expect(await ports.githubCredentials.get()).toBeNull();
    expect((await ports.settingsStore.getSecret("slack_user_token")).state).toBe("not_configured");
  });

  it("writes every provided section as the owner user, in the same transaction", async () => {
    expect((await finish()).ok).toBe(true);
    expect(uow.runs).toBe(1);
    const key = await ports.settingsStore.getSecret("anthropic_api_key");
    expect(key).toMatchObject({ state: "ready", value: ANTHROPIC_KEY });
    expect(await ports.githubCredentials.get()).toMatchObject({ meta: { login: "octocat" } });
    expect((await ports.githubRepos.listRepos()).map((r) => r.canonical)).toEqual(["acme/api"]);
    expect(await ports.settingsStore.getSecret("slack_user_token")).toMatchObject({
      state: "ready",
      value: USER_TOKEN,
      meta: { savedByUserId: "owner" },
    });
    expect((await ports.settingsStore.getSecret("slack_signing_secret")).state).toBe("ready");
    const events = await ports.reviewEvents.list({ limit: 100 });
    expect(events.length).toBeGreaterThanOrEqual(4);
    for (const e of events) expect(e.actor).toEqual({ kind: "user", id: "owner" });
  });

  it("is conflict once initialized, before hashing or calling any provider", async () => {
    await ports.loginTokens.initialize("pbkdf2-sha256$fake$0$eA");
    const out = await finish();
    expect(out).toEqual({ ok: false, error: { kind: "conflict", reason: "already initialized" } });
    expect(uow.runs).toBe(0);
    expect(verifier.calls).toEqual([]);
    expect(slack.calls).toEqual([]);
    expect(auth.signIns).toHaveLength(0);
  });

  it.each([
    [{ token: "short", confirm: "short" }, "token"],
    [{ token: LOGIN, confirm: `${LOGIN}!` }, "confirm"],
  ])("rejects a bad login token on its field and writes nothing (%#)", async (tokens, field) => {
    const out = await finish({ ...full(), ...tokens });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ kind: "validation", field });
    await nothingWritten();
  });

  it.each<[Partial<FinishSetupInput>, string]>([
    [{ anthropic: { apiKey: ANTHROPIC_KEY, authToken: ANTHROPIC_KEY } }, "anthropic.credential"],
    [{ anthropic: { apiKey: ANTHROPIC_KEY, baseUrl: "ftp://x" } }, "anthropic.baseUrl"],
    [{ anthropic: {} }, "anthropic.credential"],
    [{ github: { token: "", repos: [] } }, "github.token"],
    [{ github: { token: "ghp_unknownSENTINEL0123456789abcdef", repos: [] } }, "github.token"],
    [{ github: { token: GITHUB_TOKEN, repos: ["not a repo"] } }, "github.repos"],
    [{ github: { token: GITHUB_TOKEN, repos: ["acme/secret"] } }, "github.repos"],
    [{ slack: { userToken: "xoxb-not-a-user-token-000000" } }, "slack.userToken"],
    [{ slack: { userToken: USER_TOKEN, signingSecret: "nothex" } }, "slack.signingSecret"],
    [{ slack: { userToken: "xoxp-0000-FAKE-unknown-user-token-9" } }, "slack.userToken"],
  ])(
    "a section that fails validation names its field path and writes nothing (%#)",
    async (patch, field) => {
      const out = await finish({ ...full(), ...patch });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.field).toBe(field);
      await nothingWritten();
    },
  );

  it("an unreachable provider fails on its section", async () => {
    slack.failNext("server_error");
    const out = await finish();
    expect(out).toMatchObject({ ok: false, error: { kind: "upstream", field: "slack" } });
    await nothingWritten();
  });

  it("an omitted section leaves its stored rows untouched", async () => {
    await seedSlack();
    expect((await finish({ token: LOGIN, confirm: LOGIN })).ok).toBe(true);
    expect(await ports.settingsStore.getSecret("slack_user_token")).toMatchObject({
      state: "ready",
      meta: { savedByUserId: "earlier" },
    });
  });

  it("a lost race inside the transaction is conflict and signs nobody in", async () => {
    const real = ports.loginTokens.isInitialized.bind(ports.loginTokens);
    let first = true;
    ports.loginTokens.isInitialized = async () => (first ? ((first = false), false) : real());
    await ports.loginTokens.initialize("pbkdf2-sha256$fake$0$eA");
    const out = await finish({ token: LOGIN, confirm: LOGIN });
    expect(out).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(auth.signIns).toHaveLength(0);
  });

  it("lets exactly one of several concurrent setups win", async () => {
    const results = await Promise.all(
      ["token-aaaaaa", "token-bbbbbb", "token-cccccc"].map((t) => finish({ token: t, confirm: t })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.kind === "conflict")).toHaveLength(2);
    expect(auth.signIns).toHaveLength(1);
  });

  it("is rate limited per IP in the setup namespace", async () => {
    for (let i = 0; i < SETUP_ATTEMPT_POLICY.limit; i++) {
      await finish({ token: LOGIN, confirm: "nope" });
    }
    const out = await finish();
    expect(out).toMatchObject({ ok: false, error: { kind: "rate_limited" } });
    expect(setupAttemptKey(IP)).toBe(`setup:${IP}`);
    // The login namespace is untouched.
    const login = await ports.attemptLimiter.attempt(`login:${IP}`, SETUP_ATTEMPT_POLICY);
    expect(login.allowed).toBe(true);
  });

  it("never logs a secret or the login token", async () => {
    await finish();
    await finish({ ...full(), confirm: "x" });
    const text = JSON.stringify(logger.entries);
    for (const secret of [LOGIN, ANTHROPIC_KEY, GITHUB_TOKEN, USER_TOKEN, SIGNING_SECRET]) {
      expect(text).not.toContain(secret);
    }
    expect(logger.entries.some((e) => e.msg === "setup finished")).toBe(true);
  });
});

describe("setup-only checks", () => {
  it("getSetupSections reports which sections are stored, as booleans only", async () => {
    expect(await getSetupSections(ports, IP)).toEqual({
      ok: true,
      value: { anthropic: false, github: false, slack: false },
    });
    await seedSlack();
    expect(await getSetupSections(ports, IP)).toEqual({
      ok: true,
      value: { anthropic: false, github: false, slack: true },
    });
  });

  it("testSetupAnthropic probes with the probe model and writes nothing", async () => {
    const out = await testSetupAnthropic(ports, { apiKey: ANTHROPIC_KEY }, IP);
    expect(out).toMatchObject({ ok: true, value: { verdict: "verified" } });
    expect(probes.map((p) => p.model)).toEqual([ANTHROPIC_PROBE_MODEL]);
    expect((await ports.settingsStore.getSecret("anthropic_api_key")).state).toBe("not_configured");
  });

  it("testSetupAnthropic names the field of a bad input", async () => {
    const out = await testSetupAnthropic(ports, {}, IP);
    expect(out).toMatchObject({ ok: false, error: { field: "anthropic.credential" } });
    expect(probes).toEqual([]);
  });

  it("listSetupGithubRepos verifies the given token and lists its repos, writing nothing", async () => {
    (ports.github as FakeGitHub).world.addAccessibleRepo({ fullName: "acme/api", private: true });
    (ports.github as FakeGitHub).world.addAccessibleRepo({ fullName: "acme/old", archived: true });
    const out = await listSetupGithubRepos(ports, { token: GITHUB_TOKEN }, IP);
    expect(out).toEqual({
      ok: true,
      value: {
        login: "octocat",
        repos: [{ fullName: "acme/api", private: true, canPush: true }],
        truncated: false,
      },
    });
    expect(await ports.githubCredentials.get()).toBeNull();
    const bad = await listSetupGithubRepos(ports, { token: "nope" }, IP);
    expect(bad).toMatchObject({ ok: false, error: { field: "github.token" } });
  });

  it("testSetupSlack checks the user token and writes nothing", async () => {
    expect(await testSetupSlack(ports, { userToken: USER_TOKEN }, IP)).toEqual({
      ok: true,
      value: { teamName: "Acme" },
    });
    expect((await ports.settingsStore.getSecret("slack_user_token")).state).toBe("not_configured");
    const bad = await testSetupSlack(ports, { userToken: "xoxb-1" }, IP);
    expect(bad).toMatchObject({ ok: false, error: { field: "slack.userToken" } });
  });

  it("every check is conflict once initialized, without calling a provider", async () => {
    await ports.loginTokens.initialize("pbkdf2-sha256$fake$0$eA");
    const outs = [
      await getSetupSections(ports, IP),
      await testSetupAnthropic(ports, { apiKey: ANTHROPIC_KEY }, IP),
      await listSetupGithubRepos(ports, { token: GITHUB_TOKEN }, IP),
      await testSetupSlack(ports, { userToken: USER_TOKEN }, IP),
    ];
    for (const out of outs) expect(out).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(probes).toEqual([]);
    expect(verifier.calls).toEqual([]);
    expect(slack.calls).toEqual([]);
  });

  it("the checks share the per-IP setup limit", async () => {
    for (let i = 0; i < SETUP_ATTEMPT_POLICY.limit; i++) await getSetupSections(ports, IP);
    expect(await testSetupSlack(ports, { userToken: USER_TOKEN }, IP)).toMatchObject({
      ok: false,
      error: { kind: "rate_limited" },
    });
    expect((await getSetupSections(ports, "198.51.100.1")).ok).toBe(true);
  });
});
