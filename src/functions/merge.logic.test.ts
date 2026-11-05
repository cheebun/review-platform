import { describe, expect, it } from "vitest";
import { harness, PR1, PR2, SHA_A, SHA_B, T0 } from "../application/review/harness.test-support";
import { processNextReviewJob } from "../application/review/review-job-consumer";
import type { ShipDeps } from "../application/ship/ship";
import type { Actor } from "../domain/shared/actor";
import { ok } from "../domain/shared/result";
import type { GitHubPort } from "../ports/github";
import { createTestContainer } from "../testing/container";
import type { FakeTokenCipher } from "../testing/fakes/fake-token-cipher";
import { InMemoryRateLimiter } from "../testing/fakes/in-memory-rate-limiter";
import {
  loadMergeGates,
  loadMergeHistory,
  loadMergeQueue,
  MERGE_RATE_LIMIT,
  parseMergeGatesInput,
  parseMergeHistoryInput,
  parseMergeInput,
  runMerge,
  type MergeDeps,
} from "./merge.logic";

// A test sentinel, never a real credential.
const TOKEN = "github_pat_MERGESENTINEL0123456789abcdefLAST";
const OWNER: Actor = { kind: "user", userId: "user-1", email: "owner@example.com" };
const OTHER: Actor = { kind: "user", userId: "user-2", email: "other@example.com" };
const MACHINE: Actor = { kind: "machine", name: "machine" };
const ref1 = { owner: "acme", repo: "app", number: 1 };
const ref2 = { owner: "acme", repo: "app", number: 2 };

type Setup = {
  token?: boolean;
  repos?: string[];
  autoApprove?: boolean;
  reviewPr2?: boolean;
};

async function setup(opts: Setup = {}) {
  const h = harness();
  if (opts.autoApprove === false) h.setRepos([]);
  await h.enqueue();
  if (opts.reviewPr2) await h.enqueue({ urls: [PR2] });
  while ((await processNextReviewJob(h.deps, "worker")).kind !== "idle");
  h.setRepos(["acme/app"]);

  const container = createTestContainer({ clock: h.clock });
  const ports = container.ports;
  if (opts.token !== false) {
    await ports.githubCredentials.save(
      {
        encrypted: ports.tokenCipher.encrypt(TOKEN),
        login: "owner-login",
        avatarUrl: "https://avatars.example/u.png",
        last4: "LAST",
        tokenKind: "fine_grained",
        scopes: null,
        savedAt: T0,
        savedByUserId: "user-1",
      },
      () => ({
        id: "evt-token",
        type: "github_token_saved",
        actor: { kind: "user", id: "user-1" },
        at: T0,
      }),
    );
  }
  for (const canonical of opts.repos ?? ["acme/app"]) {
    const [owner, repo] = canonical.split("/") as [string, string];
    await ports.githubRepos.addRepo(
      {
        owner,
        repo,
        canonical,
        access: "ok",
        permissions: null,
        checkedAt: T0,
        addedAt: T0,
        addedBy: "user-1",
      },
      {
        max: 20,
        event: () => ({
          id: `evt-${canonical}`,
          type: "github_repo_added",
          actor: { kind: "user", id: "user-1" },
          at: T0,
        }),
      },
    );
  }

  const tokens: string[] = [];
  const shipFor = (github: GitHubPort): ShipDeps => ({
    github,
    records: h.records,
    events: h.events,
    jobs: h.jobs,
    threads: h.threads,
    uow: h.uow,
    repoList: async () => (await ports.githubRepos.listRepos()).map((r) => r.canonical),
    clock: h.clock,
    ids: h.ids,
    logger: h.logger,
    timers: h.timers,
  });
  const deps: MergeDeps = {
    ...ports,
    reviewEvents: h.events,
    reviewRecords: h.records,
    rateLimiter: new InMemoryRateLimiter(h.clock),
    githubClient: (token) => {
      tokens.push(token);
      return h.github;
    },
    shipDeps: shipFor,
  };
  return { h, ports, deps, tokens };
}

const valueOf = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};

describe("validators", () => {
  it("parseMergeGatesInput keeps only a bounded string prUrl", () => {
    expect(parseMergeGatesInput({ prUrl: PR1 })).toEqual({ prUrl: PR1 });
    for (const bad of [undefined, null, {}, { prUrl: 1 }, { prUrl: "x".repeat(501) }, [PR1]]) {
      expect(() => parseMergeGatesInput(bad)).toThrow();
    }
    expect(() => parseMergeGatesInput({ prUrl: PR1, extra: 1 })).toThrow();
  });

  it("parseMergeInput pins a full hex head SHA", () => {
    expect(parseMergeInput({ prUrl: PR1, expectedSha: SHA_A })).toEqual({
      prUrl: PR1,
      expectedSha: SHA_A,
    });
    for (const sha of [undefined, "", "abc1234", "g".repeat(40), `${SHA_A}0`, 7]) {
      expect(() => parseMergeInput({ prUrl: PR1, expectedSha: sha })).toThrow();
    }
  });

  it("parseMergeHistoryInput accepts an optional limit 1..100", () => {
    expect(parseMergeHistoryInput(undefined)).toEqual({});
    expect(parseMergeHistoryInput({ limit: 40 })).toEqual({ limit: 40 });
    for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "x" }]) {
      expect(() => parseMergeHistoryInput(bad)).toThrow();
    }
  });
});

describe("loadMergeQueue", () => {
  it("lists the latest completed review of each open, unmerged PR in a listed repo", async () => {
    const t = await setup({ reviewPr2: true });
    t.h.world.getPr(ref1)!.title = "Fix <b>cart</b> total";
    t.h.world.getPr(ref2)!.state = "closed";
    await t.h.records.insert({
      ...(await t.h.records.latestForPr(PR1))!,
      id: "rec-other-repo",
      jobId: "job-other",
      prUrl: "https://github.com/other/x/pull/3",
      owner: "other",
      repo: "x",
      number: 3,
    });
    const view = valueOf(await loadMergeQueue(t.deps, OWNER));
    expect(view.github).toBe("ready");
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      prUrl: PR1,
      repo: "acme/app",
      number: 1,
      title: "Fix <b>cart</b> total",
      author: "author-a",
      reviewedSha: SHA_A,
      shortSha: SHA_A.slice(0, 7),
      verdict: "pass",
      forceApproved: false,
    });
    expect(t.tokens).toEqual([TOKEN]);
  });

  it("shows only the newest review of a PR", async () => {
    const t = await setup();
    const latest = (await t.h.records.latestForPr(PR1))!;
    await t.h.records.insert({
      ...latest,
      id: "rec-newer",
      jobId: "job-newer",
      finishedAt: new Date(latest.finishedAt.getTime() + 60_000),
    });
    const view = valueOf(await loadMergeQueue(t.deps, OWNER));
    expect(view.items.map((i) => i.reviewId)).toEqual(["rec-newer"]);
  });

  it("drops a PR with a recorded merge even if GitHub still reports it open", async () => {
    const t = await setup();
    await t.h.events.append({
      id: "evt-merged",
      type: "merged",
      actor: { kind: "user", id: "user-1" },
      at: T0,
      prUrl: PR1,
      sha: SHA_A,
      source: "slack",
    });
    expect(valueOf(await loadMergeQueue(t.deps, OWNER)).items).toEqual([]);
  });

  it("marks a PR force-approved at the reviewed head (P0 overridden)", async () => {
    const t = await setup();
    await t.h.events.append({
      id: "evt-forced",
      type: "force_approved",
      actor: { kind: "user", id: "user-1" },
      at: T0,
      prUrl: PR1,
      sha: SHA_A,
      source: "slack",
    });
    expect(valueOf(await loadMergeQueue(t.deps, OWNER)).items[0]?.forceApproved).toBe(true);
  });

  it("keeps a PR whose GitHub read failed, without title", async () => {
    const t = await setup();
    t.h.world.failNext({ kind: "bad_gateway" });
    const view = valueOf(await loadMergeQueue(t.deps, OWNER));
    expect(view.items).toMatchObject([{ prUrl: PR1, title: null, author: null }]);
  });

  it("GitHub not configured, needing a reset, or no repos: a state and no GitHub calls", async () => {
    const none = await setup({ token: false });
    expect(valueOf(await loadMergeQueue(none.deps, OWNER))).toEqual({
      github: "not_configured",
      items: [],
    });
    const reset = await setup();
    (reset.ports.tokenCipher as FakeTokenCipher).rotate();
    expect(valueOf(await loadMergeQueue(reset.deps, OWNER)).github).toBe("needs_reset");
    const empty = await setup({ repos: [] });
    expect(valueOf(await loadMergeQueue(empty.deps, OWNER))).toEqual({
      github: "no_repos",
      items: [],
    });
    expect([...none.tokens, ...reset.tokens, ...empty.tokens]).toEqual([]);
  });
});

describe("loadMergeGates", () => {
  it("returns every gate at the live head; all pass after auto-approve", async () => {
    const t = await setup();
    const view = valueOf(await loadMergeGates(t.deps, OWNER, { prUrl: PR1 }));
    expect(view).toMatchObject({
      prUrl: PR1,
      headSha: SHA_A,
      shortSha: SHA_A.slice(0, 7),
      state: "open",
      canMerge: true,
      blockedReason: null,
      p0Waived: false,
    });
    expect(view.gates.map((g) => g.status)).toEqual(Array(7).fill("pass"));
  });

  it("without an approval: the approval gate fails and the reason is notApproved", async () => {
    const t = await setup({ autoApprove: false });
    const view = valueOf(await loadMergeGates(t.deps, OWNER, { prUrl: PR1 }));
    expect(view.canMerge).toBe(false);
    expect(view.blockedReason).toBe("notApproved");
    expect(view.gates.find((g) => g.id === "approved_at_sha")?.status).toBe("fail");
  });

  it("an uncomputed mergeable is unknown, and blocks", async () => {
    const t = await setup();
    t.h.world.setMergeableComputing(ref1, 100);
    const view = valueOf(await loadMergeGates(t.deps, OWNER, { prUrl: PR1 }));
    expect(view.gates.find((g) => g.id === "mergeable")?.status).toBe("unknown");
    expect(view).toMatchObject({ canMerge: false, blockedReason: "mergeableUnknown" });
  });

  it("a PR outside the repo list is not_found, with no GitHub client built", async () => {
    const t = await setup();
    const out = await loadMergeGates(t.deps, OWNER, {
      prUrl: "https://github.com/other/x/pull/3",
    });
    expect(out).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(t.tokens).toEqual([]);
  });

  it("a malformed PR URL is a validation error", async () => {
    const t = await setup();
    const out = await loadMergeGates(t.deps, OWNER, { prUrl: "https://gitlab.com/a/b/pull/1" });
    expect(out).toMatchObject({ ok: false, error: { kind: "validation" } });
  });
});

describe("runMerge", () => {
  it("merges from the web as the signed-in user and records it", async () => {
    const t = await setup();
    const out = await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A });
    expect(valueOf(out)).toMatchObject({ status: "merged", sha: SHA_A });
    const merged = (await t.h.events.list({ prUrl: PR1, types: ["merged"], limit: 5 }))[0];
    expect(merged).toMatchObject({ source: "web", actor: { kind: "user", id: "user-1" } });
    expect(t.h.world.getPr(ref1)!.merged).toBe(true);
  });

  it("head moved since the page loaded: refused with headMoved, nothing merged", async () => {
    const t = await setup();
    const out = valueOf(await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_B }));
    expect(out).toMatchObject({ status: "refused", reason: "headMoved", headMoved: true });
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("a gate refusal returns its reason code and the gates", async () => {
    const t = await setup({ autoApprove: false });
    const out = valueOf(await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A }));
    expect(out).toMatchObject({ status: "refused", reason: "notApproved", headMoved: false });
    if (out.status !== "refused") return;
    expect(out.gates.find((g) => g.id === "approved_at_sha")?.status).toBe("fail");
    expect(out.requestId).toEqual(expect.any(String));
  });

  it("a merge GitHub rejects is githubRejected; GitHub's text is never returned (S4)", async () => {
    const t = await setup();
    t.h.world.setMergeSettings(
      { owner: "acme", repo: "app" },
      { merge: false, squash: false, rebase: false },
    );
    const out = await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A });
    expect(valueOf(out)).toMatchObject({ status: "refused", reason: "githubRejected" });
    expect(JSON.stringify(out)).not.toMatch(/not allowed|merge method/i);
  });

  it("an already merged PR is reported as such", async () => {
    const t = await setup();
    await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A });
    expect(await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A })).toEqual(
      ok({ status: "already_merged" }),
    );
  });

  it("machine actors are forbidden before any GitHub call or rate-limit hit", async () => {
    const t = await setup();
    let hits = 0;
    t.deps.rateLimiter = {
      hit: async () => (hits++, { allowed: true, remaining: 1, retryAfterMs: 0 }),
    };
    const out = await runMerge(t.deps, MACHINE, { prUrl: PR1, expectedSha: SHA_A });
    expect(out).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect([hits, t.tokens.length, t.h.world.count("merge")]).toEqual([0, 0, 0]);
  });

  it(`is rate limited per user: ${MERGE_RATE_LIMIT.limit} per window, then rate_limited`, async () => {
    const t = await setup();
    for (let i = 0; i < MERGE_RATE_LIMIT.limit; i++) {
      valueOf(await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_B }));
    }
    const limited = await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A });
    expect(limited).toMatchObject({ ok: false, error: { kind: "rate_limited" } });
    // Another user has their own budget.
    expect(await runMerge(t.deps, OTHER, { prUrl: PR1, expectedSha: SHA_B })).toMatchObject({
      ok: true,
    });
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("a repo outside the list is refused before any GitHub call", async () => {
    const t = await setup();
    const out = valueOf(
      await runMerge(t.deps, OWNER, {
        prUrl: "https://github.com/other/x/pull/3",
        expectedSha: SHA_A,
      }),
    );
    expect(out).toMatchObject({ status: "refused", reason: "repoNotAllowed" });
    expect(t.tokens).toEqual([]);
  });

  it("GitHub not configured is a not_configured error with the fixed message", async () => {
    const t = await setup({ token: false });
    const out = await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A });
    expect(out).toMatchObject({
      ok: false,
      error: {
        kind: "not_configured",
        message: "This feature is not configured on the server.",
        requestId: expect.any(String),
      },
    });
  });

  it("never returns or logs the token", async () => {
    const t = await setup();
    const out = [
      await loadMergeQueue(t.deps, OWNER),
      await loadMergeGates(t.deps, OWNER, { prUrl: PR1 }),
      await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A }),
      await loadMergeHistory(t.deps, OWNER, {}),
    ];
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(t.ports.logger)).not.toContain(TOKEN);
    expect(JSON.stringify(t.h.logger)).not.toContain(TOKEN);
  });
});

describe("loadMergeHistory", () => {
  it("lists merged events newest first with PR, SHAs, actor and source", async () => {
    const t = await setup({ reviewPr2: true });
    await runMerge(t.deps, OWNER, { prUrl: PR1, expectedSha: SHA_A });
    t.h.clock.advance(60_000);
    await t.h.events.append({
      id: "evt-slack-merge",
      type: "merged",
      actor: { kind: "user", id: "user-2" },
      at: t.h.clock.now(),
      prUrl: PR2,
      sha: SHA_B,
      source: "slack",
      detail: { mergeSha: "c".repeat(40) },
    });
    const view = valueOf(await loadMergeHistory(t.deps, OWNER, {}));
    expect(view.hasMore).toBe(false);
    expect(view.items).toMatchObject([
      {
        prUrl: PR2,
        repo: "acme/app",
        number: 2,
        sha: SHA_B,
        mergeSha: "c".repeat(40),
        source: "slack",
        actor: { kind: "user", id: "user-2", self: false },
      },
      {
        prUrl: PR1,
        number: 1,
        sha: SHA_A,
        mergeSha: `merge-commit-of-${SHA_A}`,
        source: "web",
        actor: { kind: "user", id: "user-1", self: true },
      },
    ]);
  });

  it("pages by limit and says when there is more", async () => {
    const t = await setup();
    for (let i = 0; i < 3; i++) {
      await t.h.events.append({
        id: `evt-m-${i}`,
        type: "merged",
        actor: { kind: "user", id: "user-1" },
        at: new Date(T0.getTime() + i * 1000),
        prUrl: PR1,
        sha: SHA_A,
        source: "web",
      });
    }
    const page = valueOf(await loadMergeHistory(t.deps, OWNER, { limit: 2 }));
    expect([page.items.length, page.hasMore]).toEqual([2, true]);
    expect(valueOf(await loadMergeHistory(t.deps, OWNER, { limit: 3 })).hasMore).toBe(false);
  });

  it("is readable without GitHub", async () => {
    const t = await setup({ token: false });
    expect(valueOf(await loadMergeHistory(t.deps, OWNER, {}))).toEqual({
      items: [],
      hasMore: false,
    });
  });
});
