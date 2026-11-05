import { describe, expect, it, vi } from "vitest";
import { err } from "../domain/shared/result";
import type { NewReviewEvent } from "../ports/review-event-repo";
import type { NewReviewRecord, ReviewRecordRepo } from "../ports/review-record-repo";
import type { SecretKind } from "../ports/settings-store";
import { createTestContainer } from "../testing/container";
import { FakeClock } from "../testing/fakes/fake-clock";
import type { FakeTokenCipher } from "../testing/fakes/fake-token-cipher";
import { InMemoryReviewRecordRepo } from "../testing/fakes/in-memory-review-record-repo";
import {
  fakeSecretCiphers,
  type InMemorySettingsStore,
} from "../testing/fakes/in-memory-settings-store";
import {
  LATEST_REVIEWS,
  loadMergeSummary,
  loadReviewSummary,
  loadSetupStatus,
  reviewWindow,
  type WorkbenchDeps,
} from "./workbench.logic";

// Test sentinels, never real credentials.
const GH_TOKEN = "github_pat_WORKBENCHSENTINEL0123456789LAST";
const SECRET = "sentinel-secret-WORKBENCH-0001";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA2 = "ffffeeee0000111122223333444455556666aaaa";
/** 2026-11-06 01:00 in UTC+8: the UTC+8 day is already the 6th. */
const NOW = new Date("2026-11-05T17:00:00.000Z");
const T0 = new Date("2026-11-01T00:00:00.000Z");

let seq = 0;
const aRecord = (over: Partial<NewReviewRecord> = {}): NewReviewRecord => {
  seq += 1;
  const owner = over.owner ?? "acme";
  const repo = over.repo ?? "web";
  const number = over.number ?? seq;
  const finishedAt = over.finishedAt ?? new Date(NOW.getTime() - 3600_000 - seq * 1000);
  const failed = over.status === "failed";
  return {
    id: `rev-${seq}`,
    jobId: `job-${seq}`,
    run: 1,
    prUrl: `https://github.com/${owner}/${repo}/pull/${number}`,
    owner,
    repo,
    number,
    headSha: SHA,
    source: "slack",
    requester: { kind: "slack", id: "U1" },
    startedAt: new Date(finishedAt.getTime() - 60_000),
    finishedAt,
    status: "completed",
    ...(failed ? { errorCategory: "upstream_llm" } : { verdict: "pass" as const }),
    findings: [],
    ...over,
  };
};

async function setup(opts: { repos?: string[]; token?: boolean } = {}) {
  const clock = new FakeClock(NOW);
  const reviewRecords = new InMemoryReviewRecordRepo();
  const { ports } = createTestContainer({ clock, reviewRecords });
  for (const canonical of opts.repos ?? ["acme/web"]) {
    const [owner, repo] = canonical.split("/") as [string, string];
    const added = await ports.githubRepos.addRepo(
      {
        owner,
        repo,
        canonical,
        access: "ok",
        permissions: null,
        checkedAt: T0,
        addedAt: T0,
        addedBy: "u1",
      },
      {
        max: 50,
        event: () => ({
          id: `evt-repo-${canonical}`,
          type: "github_repo_added",
          actor: { kind: "user", id: "u1" },
          at: T0,
        }),
      },
    );
    if (!added.ok) throw new Error("seed failed");
  }
  if (opts.token) {
    await ports.githubCredentials.save(
      {
        encrypted: ports.tokenCipher.encrypt(GH_TOKEN),
        login: "owner-login",
        avatarUrl: "https://avatars.example/u.png",
        last4: "LAST",
        tokenKind: "fine_grained",
        scopes: null,
        savedAt: T0,
        savedByUserId: "u1",
      },
      () => ({
        id: "evt-token",
        type: "github_token_saved",
        actor: { kind: "user", id: "u1" },
        at: T0,
      }),
    );
  }
  const githubCalls: string[] = [];
  const deps: WorkbenchDeps & { githubClient: () => never } = {
    ...ports,
    githubClient: () => {
      githubCalls.push("githubClient");
      throw new Error("the workbench must not call GitHub");
    },
  };
  const insert = async (over: Partial<NewReviewRecord> = {}) => {
    const r = await reviewRecords.insert(aRecord(over));
    if (!r.ok) throw new Error(`insert failed: ${JSON.stringify(r.error)}`);
    return r.value.record;
  };
  const event = (e: Partial<NewReviewEvent> & Pick<NewReviewEvent, "type">) => {
    seq += 1;
    return ports.reviewEvents.append({
      id: `ev-${seq}`,
      actor: { kind: "system", id: "owner" },
      at: NOW,
      ...e,
    });
  };
  const saveSecret = (kind: SecretKind, value = SECRET) =>
    ports.settingsStore.saveSecret(
      kind,
      { value, savedAt: T0, savedByUserId: "u1", verifiedAt: T0, testResult: null },
      () => ({
        id: `evt-${kind}-${(seq += 1)}`,
        type: "slack_secret_saved",
        actor: { kind: "user", id: "u1" },
        at: T0,
      }),
    );
  return { ports, deps, insert, event, saveSecret, githubCalls, clock };
}

// ---- reviewWindow ----

describe("reviewWindow", () => {
  it("covers the last 7 UTC+8 calendar days, today included", () => {
    expect(reviewWindow(NOW)).toEqual({
      from: "2026-10-31",
      to: "2026-11-06",
      days: 7,
      start: new Date("2026-10-30T16:00:00.000Z"),
    });
  });

  it("uses the UTC+8 day, not the UTC day", () => {
    // 15:59 UTC is still 23:59 on the same UTC+8 day.
    expect(reviewWindow(new Date("2026-11-05T15:59:00.000Z"))).toMatchObject({
      from: "2026-10-30",
      to: "2026-11-05",
    });
  });
});

// ---- Review summary ----

describe("loadReviewSummary", () => {
  it("counts listed-repo reviews in the window by outcome", async () => {
    const s = await setup({ repos: ["acme/web", "acme/api"] });
    await s.insert({ verdict: "pass" });
    await s.insert({ verdict: "pass", owner: "acme", repo: "api" });
    await s.insert({ verdict: "changes_requested" });
    await s.insert({ status: "failed" });
    // Outside the window (before 10-31 00:00 UTC+8) and outside the repo list: not counted.
    await s.insert({ verdict: "pass", finishedAt: new Date("2026-10-30T15:59:59.000Z") });
    await s.insert({ verdict: "changes_requested", owner: "evil", repo: "x" });

    const r = await loadReviewSummary(s.deps);
    expect(r).toMatchObject({
      ok: true,
      value: {
        window: { from: "2026-10-31", to: "2026-11-06", days: 7 },
        counts: { pass: 2, changes_requested: 1, failed: 1 },
        truncated: false,
      },
    });
  });

  it("lists the newest listed-repo reviews, older than the window included", async () => {
    const s = await setup();
    const old = await s.insert({ finishedAt: new Date("2026-09-01T00:00:00.000Z"), number: 40 });
    await s.insert({ owner: "evil", repo: "x" });
    const failed = await s.insert({ status: "failed", number: 41 });
    const newest = await s.insert({
      verdict: "changes_requested",
      number: 42,
      finishedAt: new Date(NOW.getTime() - 1000),
    });

    const r = await loadReviewSummary(s.deps);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.latest).toEqual([
      {
        id: newest.id,
        repo: "acme/web",
        number: 42,
        status: "completed",
        verdict: "changes_requested",
        finishedAt: newest.finishedAt.toISOString(),
      },
      {
        id: failed.id,
        repo: "acme/web",
        number: 41,
        status: "failed",
        verdict: null,
        finishedAt: failed.finishedAt.toISOString(),
      },
      expect.objectContaining({ id: old.id, number: 40 }),
    ]);
  });

  it(`keeps at most ${LATEST_REVIEWS} latest reviews`, async () => {
    const s = await setup();
    for (let i = 0; i < LATEST_REVIEWS + 3; i++) await s.insert();
    const r = await loadReviewSummary(s.deps);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.latest).toHaveLength(LATEST_REVIEWS);
    expect(r.value.counts.pass).toBe(LATEST_REVIEWS + 3);
  });

  it("with no listed repos, shows nothing", async () => {
    const s = await setup({ repos: [] });
    await s.insert();
    const r = await loadReviewSummary(s.deps);
    expect(r).toMatchObject({
      ok: true,
      value: { counts: { pass: 0, changes_requested: 0, failed: 0 }, latest: [] },
    });
  });

  it("flags truncated counts when the window holds more than the scan cap", async () => {
    const s = await setup();
    for (let i = 0; i < 1001; i++) await s.insert();
    const r = await loadReviewSummary(s.deps);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.truncated).toBe(true);
    expect(r.value.counts.pass).toBe(1000);
  });

  it("a store error is data with a request id and no internals", async () => {
    const s = await setup();
    const broken = {
      list: async () => err({ kind: "upstream", service: "db", retryable: true }),
    } as unknown as ReviewRecordRepo;
    const r = await loadReviewSummary({ ...s.deps, reviewRecords: broken });
    expect(r).toMatchObject({ ok: false, error: { kind: "upstream" } });
    if (r.ok) throw new Error("expected error");
    expect(r.error.requestId).toEqual(expect.any(String));
  });

  it("a thrown error becomes a fixed 500 body", async () => {
    const s = await setup();
    const broken = {
      list: async () => {
        throw new Error("connection to db.internal:5432 refused");
      },
    } as unknown as ReviewRecordRepo;
    const r = await loadReviewSummary({ ...s.deps, reviewRecords: broken });
    expect(r).toMatchObject({ ok: false, error: { kind: "internal" } });
    expect(JSON.stringify(r)).not.toContain("db.internal");
  });
});

// ---- Merge summary ----

describe("loadMergeSummary", () => {
  it("without a token: not_configured", async () => {
    const s = await setup();
    expect(await loadMergeSummary(s.deps)).toEqual({
      ok: true,
      value: { github: "not_configured", awaiting: 0, passing: 0, capped: false },
    });
  });

  it("with a token that cannot be decrypted: needs_reset", async () => {
    const s = await setup({ token: true });
    (s.ports.tokenCipher as FakeTokenCipher).rotate();
    expect(await loadMergeSummary(s.deps)).toMatchObject({
      ok: true,
      value: { github: "needs_reset" },
    });
  });

  it("with no repos: no_repos", async () => {
    const s = await setup({ token: true, repos: [] });
    expect(await loadMergeSummary(s.deps)).toMatchObject({
      ok: true,
      value: { github: "no_repos" },
    });
  });

  it("counts reviewed, unmerged PRs from local records, without calling GitHub", async () => {
    const s = await setup({ token: true });
    // PR 1: an older 🔴 superseded by a newer 🟢 → awaiting, passing.
    await s.insert({ number: 1, verdict: "changes_requested", finishedAt: new Date(T0) });
    await s.insert({ number: 1, verdict: "pass" });
    // PR 2: 🔴 → awaiting, not passing.
    await s.insert({ number: 2, verdict: "changes_requested" });
    // PR 3: merged → not awaiting.
    const merged = await s.insert({ number: 3, verdict: "pass" });
    await s.event({ type: "merged", prUrl: merged.prUrl, sha: SHA });
    // PR 4: 🔴 force approved at the reviewed head → passing.
    const forced = await s.insert({ number: 4, verdict: "changes_requested" });
    await s.event({ type: "force_approved", prUrl: forced.prUrl, sha: SHA.toUpperCase() });
    // PR 5: 🔴 force approved at an older head → not passing.
    const stale = await s.insert({ number: 5, verdict: "changes_requested" });
    await s.event({ type: "force_approved", prUrl: stale.prUrl, sha: SHA2 });
    // PR 6: failed review only → not in the queue. PR 7: outside the repo list.
    await s.insert({ number: 6, status: "failed" });
    await s.insert({ number: 7, owner: "evil", repo: "x" });

    expect(await loadMergeSummary(s.deps)).toEqual({
      ok: true,
      value: { github: "ready", awaiting: 4, passing: 2, capped: false },
    });
    expect(s.githubCalls).toEqual([]);
  });

  it("caps the count at the /merge queue size", async () => {
    const s = await setup({ token: true });
    for (let i = 1; i <= 51; i++) await s.insert({ number: i });
    expect(await loadMergeSummary(s.deps)).toMatchObject({
      ok: true,
      value: { awaiting: 50, passing: 50, capped: true },
    });
  });
});

// ---- Setup status ----

describe("loadSetupStatus", () => {
  it("with nothing stored, every section is not_configured", async () => {
    const s = await setup();
    expect(await loadSetupStatus(s.deps)).toEqual({
      ok: true,
      value: {
        github: "not_configured",
        slack: "not_configured",
        llm: "not_configured",
      },
    });
  });

  it("does not expose retired Jira configuration in setup status", async () => {
    const s = await setup();
    const secrets = vi.spyOn(s.ports.settingsStore, "getSecret");
    const values = vi.spyOn(s.ports.settingsStore, "getValues");
    const result = await loadSetupStatus(s.deps);
    expect(result.ok).toBe(true);
    expect(secrets.mock.calls.map(([kind]) => kind)).not.toContain("jira_api_token");
    for (const key of ["jira_base_url", "jira_email"]) {
      expect(values.mock.calls.flatMap(([keys]) => keys)).not.toContain(key);
    }
    if (result.ok) expect(result.value).not.toHaveProperty("jira");
  });

  it("configured sections, and never a secret value", async () => {
    const s = await setup({ token: true });
    await s.saveSecret("slack_user_token", "xoxp-sentinel-WORKBENCH");
    await s.saveSecret("anthropic_api_key", "sk-sentinel-WORKBENCH");

    const r = await loadSetupStatus(s.deps);
    expect(r).toEqual({
      ok: true,
      value: { github: "configured", slack: "configured", llm: "configured" },
    });
    const json = JSON.stringify(r);
    for (const secret of [GH_TOKEN, SECRET, "xoxp-sentinel", "sk-sentinel", "LAST"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("values that cannot be decrypted are needs_reset", async () => {
    const s = await setup({ token: true });
    await s.saveSecret("slack_user_token");
    await s.saveSecret("anthropic_api_key");
    (s.ports.tokenCipher as FakeTokenCipher).rotate();
    const rotated = (s.ports.settingsStore as InMemorySettingsStore).withCiphers(
      fakeSecretCiphers(1),
    );
    expect(await loadSetupStatus({ ...s.deps, settingsStore: rotated })).toEqual({
      ok: true,
      value: {
        github: "needs_reset",
        slack: "needs_reset",
        llm: "needs_reset",
      },
    });
  });

  it("a thrown error becomes a fixed 500 body", async () => {
    const s = await setup();
    const broken = {
      getValues: async () => ({}),
      getSecret: async () => {
        throw new Error("decrypt failed for slack_user_token=xoxp-leak");
      },
    } as unknown as WorkbenchDeps["settingsStore"];
    const r = await loadSetupStatus({ ...s.deps, settingsStore: broken });
    expect(r).toMatchObject({ ok: false, error: { kind: "internal" } });
    expect(JSON.stringify(r)).not.toContain("xoxp-leak");
  });
});
