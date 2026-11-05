import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { finishSetup, type FinishSetupInput } from "../../application/identity/setup";
import { ANTHROPIC_KEY } from "../../application/settings/llm-testing";
import { SIGNING_SECRET, USER_TOKEN } from "../../application/settings/slack-testing";
import { TOKEN as GITHUB_TOKEN } from "../../application/settings/testing";
import type { SetupUnitOfWork } from "../../ports/setup-unit-of-work";
import { createTestContainer } from "../../testing/container";
import { FakeClock } from "../../testing/fakes/fake-clock";
import type { FakeAuth } from "../../testing/fakes/fake-auth";
import { FakeGitHubVerifier } from "../../testing/fakes/fake-github-verifier";
import { FakeSlackVerifier } from "../../testing/fakes/fake-slack-verifier";
import { SequenceIdGenerator } from "../../testing/fakes/sequence-id-generator";
import { pgSchemaFixture } from "../../testing/integration/pg-fixture";
import { createSecretCiphers } from "../crypto/aes-gcm-token-cipher";
import { OWNER_USER_EMAIL } from "../auth/auth";
import { PgCredentialStore } from "./pg-credential-store";
import { loginToken } from "./pg-login-token-store-schema";
import { PgLoginTokenStore } from "./pg-login-token-store";
import { PgReviewEventRepo } from "./pg-review-event-repo";
import { settingSecret, settingValue } from "./pg-settings-store-schema";
import { PgSettingsRepo } from "./pg-settings-repo";
import { PgSettingsStore } from "./pg-settings-store";
import { PgSetupUnitOfWork } from "./pg-setup-unit-of-work";
import { githubCredential, githubRepo, reviewEvent, user } from "./schema";

// Remote PostgreSQL with a real pool: concurrent setups reach the server in parallel, so the
// login_token primary key really serialises them, and a rollback really discards every write.
const fixture = pgSchemaFixture(import.meta.url);

// Fake secrets: test vectors only.
const SECRET = "test-secret-0123456789abcdefghijklmnop";
const LOGIN = "correct horse battery";
const headers = () => new Headers();

function pgPorts(
  wrap?: (uow: SetupUnitOfWork) => SetupUnitOfWork,
): ReturnType<typeof createTestContainer>["ports"] {
  const db = fixture.db();
  const clock = new FakeClock();
  const ids = new SequenceIdGenerator();
  const ciphers = createSecretCiphers({ secret: SECRET });
  const githubVerifier = new FakeGitHubVerifier()
    .acceptToken(GITHUB_TOKEN)
    .grantRepo(GITHUB_TOKEN, "acme/api")
    .grantRepo(GITHUB_TOKEN, "acme/web");
  const slackVerifier = new FakeSlackVerifier();
  slackVerifier.userToken(USER_TOKEN);
  const uow = new PgSetupUnitOfWork(db, ciphers, clock, {
    // Owner user ids must not collide with the event ids of the same sequence.
    uuid: () => `user-${ids.uuid()}`,
  });
  return createTestContainer({
    clock,
    ids,
    loginTokens: new PgLoginTokenStore(db, clock),
    settingsStore: new PgSettingsStore(db, ciphers),
    githubCredentials: new PgCredentialStore(db),
    githubRepos: new PgSettingsRepo(db),
    reviewEvents: new PgReviewEventRepo(db),
    githubVerifier,
    slackVerifier,
    setupUnitOfWork: wrap ? wrap(uow) : uow,
  }).ports;
}

const full = (token = LOGIN): FinishSetupInput => ({
  token,
  confirm: token,
  anthropic: { apiKey: ANTHROPIC_KEY, model: "claude-sonnet-5-5" },
  github: { token: GITHUB_TOKEN, repos: ["acme/api", "acme/web"] },
  slack: { userToken: USER_TOKEN, signingSecret: SIGNING_SECRET },
});

async function counts() {
  const db = fixture.db();
  const n = async (table: PgTable) => (await db.select().from(table)).length;
  return {
    loginToken: await n(loginToken),
    user: await n(user),
    secrets: await n(settingSecret),
    values: await n(settingValue),
    githubCredential: await n(githubCredential),
    repos: await n(githubRepo),
    events: await n(reviewEvent),
  };
}

const EMPTY = {
  loginToken: 0,
  user: 0,
  secrets: 0,
  values: 0,
  githubCredential: 0,
  repos: 0,
  events: 0,
};

describe("PgSetupUnitOfWork via finishSetup", () => {
  it("commits the login token, the owner user and every section together", async () => {
    const ports = pgPorts();
    expect(await finishSetup(ports, full(), "ip", headers())).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await counts()).toEqual({
      loginToken: 1,
      user: 1,
      secrets: 3,
      values: 1,
      githubCredential: 1,
      repos: 2,
      events: 6,
    });
    const [owner] = await fixture.db().select().from(user);
    expect(owner).toMatchObject({ email: OWNER_USER_EMAIL, name: "Owner" });
    const events = await fixture.db().select().from(reviewEvent);
    for (const e of events) expect(e.actorId).toBe(owner!.id);
    expect((ports.auth as FakeAuth).signIns).toHaveLength(1);
  });

  it("reuses the oldest existing user as the owner", async () => {
    await fixture
      .db()
      .insert(user)
      .values({ id: "u-old", name: "Old", email: "old@example.com", emailVerified: true });
    const ports = pgPorts();
    expect((await finishSetup(ports, full(), "ip", headers())).ok).toBe(true);
    const events = await fixture.db().select().from(reviewEvent);
    for (const e of events) expect(e.actorId).toBe("u-old");
    expect((await counts()).user).toBe(1);
  });

  it("a failure after the settings writes rolls everything back, the login token included", async () => {
    const ports = pgPorts((uow) => ({
      run: (fn) =>
        uow.run((tx) =>
          fn({
            ...tx,
            githubRepos: {
              ...tx.githubRepos,
              listRepos: () => tx.githubRepos.listRepos(),
              addRepo: async () => {
                throw new Error("injected failure");
              },
            },
          }),
        ),
    }));
    await expect(finishSetup(ports, full(), "ip", headers())).rejects.toThrow("injected failure");
    expect(await counts()).toEqual(EMPTY);
    expect((ports.auth as FakeAuth).signIns).toHaveLength(0);

    // Nothing was left behind: a clean retry succeeds.
    expect((await finishSetup(pgPorts(), full(), "ip", headers())).ok).toBe(true);
  });

  it("an err result inside the transaction rolls back as well", async () => {
    const ports = pgPorts((uow) => ({
      run: (fn) =>
        uow.run(async (tx) => {
          const out = await fn(tx);
          return out.ok ? { ok: false, error: { kind: "conflict", reason: "injected" } } : out;
        }),
    }));
    const out = await finishSetup(ports, full(), "ip", headers());
    expect(out).toEqual({ ok: false, error: { kind: "conflict", reason: "injected" } });
    expect(await counts()).toEqual(EMPTY);
  });

  it("an existing login token is conflict and writes nothing", async () => {
    const ports = pgPorts();
    // Past the cheap pre-check: the insert inside the transaction decides.
    ports.loginTokens.isInitialized = async () => false;
    await new PgLoginTokenStore(fixture.db(), new FakeClock()).initialize(
      await ports.loginTokenHasher.hash("earlier token"),
    );
    const out = await finishSetup(ports, full(), "ip", headers());
    expect(out).toEqual({ ok: false, error: { kind: "conflict", reason: "already initialized" } });
    expect(await counts()).toEqual({ ...EMPTY, loginToken: 1 });
  });

  it("of concurrent setups exactly one wins; the others roll back as conflict", async () => {
    const ports = pgPorts();
    const tokens = ["token-aaaaaa", "token-bbbbbb", "token-cccccc", "token-dddddd"];
    const results = await Promise.all(
      tokens.map((t) => finishSetup(ports, full(t), `ip-${t}`, headers())),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) {
      expect(r).toEqual({ ok: false, error: { kind: "conflict", reason: "already initialized" } });
    }
    expect(await counts()).toEqual({
      loginToken: 1,
      user: 1,
      secrets: 3,
      values: 1,
      githubCredential: 1,
      repos: 2,
      events: 6,
    });
    expect((ports.auth as FakeAuth).signIns).toHaveLength(1);
  });
});
