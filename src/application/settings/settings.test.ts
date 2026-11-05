import { beforeEach, describe, expect, it } from "vitest";
import { ALL_UNVERIFIED, type RepoPermissions } from "../../domain/settings/permissions";
import { FULL_ACCESS } from "../../testing/fakes/fake-github-verifier";
import { addRepo, removeRepo } from "./repos";
import { removeGithubToken, saveGithubToken, TOKEN_SAVE_LIMIT } from "./github-token";
import { alice, machine, NOW, settingsSetup, TOKEN, TOKEN_2 } from "./testing";
import { getGithubAvailability, getSettingsView, resolveGithubToken } from "./view";

const READ_ONLY: RepoPermissions = {
  ...FULL_ACCESS,
  contents: { read: "granted", write: "missing" },
};

let s: ReturnType<typeof settingsSetup>;
beforeEach(() => {
  s = settingsSetup();
});

const saved = async (token = TOKEN) => {
  s.githubVerifier.acceptToken(token);
  const r = await saveGithubToken(s.deps, alice, { token });
  expect(r.ok).toBe(true);
  return r;
};

const events = async () => (await s.reviewEvents.list({ limit: 50 })).map((e) => e.type);

describe("saveGithubToken", () => {
  it("verifies, encrypts, stores display metadata and records github_token_saved", async () => {
    s.githubVerifier.acceptToken(TOKEN, { login: "alice-gh" });
    const r = await saveGithubToken(s.deps, alice, { token: `  ${TOKEN}\n` });
    expect(r).toMatchObject({
      ok: true,
      value: {
        availability: "ready",
        token: {
          login: "alice-gh",
          last4: "WXYZ",
          savedAt: NOW.toISOString(),
          tokenKind: "fine_grained",
        },
        repos: [],
        maxRepos: 50,
      },
    });
    const row = await s.githubCredentials.get();
    expect(row?.meta.savedByUserId).toBe("u-alice");
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(s.tokenCipher.decrypt(row!.encrypted)).toEqual({ ok: true, value: TOKEN });
    const [event] = await s.reviewEvents.list({ limit: 5 });
    expect(event).toMatchObject({
      type: "github_token_saved",
      actor: { kind: "user", id: "u-alice" },
      at: NOW,
      source: "web",
      detail: { login: "alice-gh", last4: "WXYZ" },
    });
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("a second save replaces the token and records github_token_replaced", async () => {
    await saved(TOKEN);
    await saved(TOKEN_2);
    expect(await events()).toEqual(["github_token_replaced", "github_token_saved"]);
    const row = await s.githubCredentials.get();
    expect(s.tokenCipher.decrypt(row!.encrypted)).toEqual({ ok: true, value: TOKEN_2 });
  });

  it("rejects a malformed token before calling GitHub", async () => {
    const r = await saveGithubToken(s.deps, alice, { token: "short" });
    expect(r).toMatchObject({ ok: false, error: { kind: "validation", field: "token" } });
    expect(s.githubVerifier.calls).toEqual([]);
  });

  it("a token GitHub rejects → forbidden 'token rejected by GitHub'; nothing stored, no event", async () => {
    const r = await saveGithubToken(s.deps, alice, { token: TOKEN });
    expect(r).toEqual({
      ok: false,
      error: { kind: "forbidden", reason: "Token rejected by GitHub." },
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(await s.githubCredentials.get()).toBeNull();
    expect(await events()).toEqual([]);
  });

  it("GitHub unavailable → upstream passes through; the old token stays", async () => {
    await saved(TOKEN);
    s.githubVerifier.failToken(TOKEN_2, { kind: "upstream", service: "github", retryable: true });
    const r = await saveGithubToken(s.deps, alice, { token: TOKEN_2 });
    expect(r).toMatchObject({ ok: false, error: { kind: "upstream", service: "github" } });
    const row = await s.githubCredentials.get();
    expect(s.tokenCipher.decrypt(row!.encrypted)).toEqual({ ok: true, value: TOKEN });
  });

  it("only a signed-in user may save", async () => {
    s.githubVerifier.acceptToken(TOKEN);
    const r = await saveGithubToken(s.deps, machine, { token: TOKEN });
    expect(r).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(s.githubVerifier.calls).toEqual([]);
  });

  it(`is rate limited to ${TOKEN_SAVE_LIMIT.limit} attempts per user per window`, async () => {
    for (let i = 0; i < TOKEN_SAVE_LIMIT.limit; i++) {
      await saveGithubToken(s.deps, alice, { token: "short" });
    }
    s.githubVerifier.acceptToken(TOKEN);
    const r = await saveGithubToken(s.deps, alice, { token: TOKEN });
    expect(r).toMatchObject({ ok: false, error: { kind: "rate_limited" } });
    s.clock.advance(TOKEN_SAVE_LIMIT.windowMs);
    expect((await saveGithubToken(s.deps, alice, { token: TOKEN })).ok).toBe(true);
  });

  it("re-checks every listed repo with the new token and flags lost access", async () => {
    await saved(TOKEN);
    s.githubVerifier.grantRepo(TOKEN, "acme/web").grantRepo(TOKEN, "acme/api");
    await addRepo(s.deps, alice, { repo: "acme/web" });
    s.clock.advance(1);
    await addRepo(s.deps, alice, { repo: "acme/api" });
    s.clock.advance(1000);

    s.githubVerifier.acceptToken(TOKEN_2).grantRepo(TOKEN_2, "acme/web", READ_ONLY);
    const r = await saveGithubToken(s.deps, alice, { token: TOKEN_2 });
    expect(r).toMatchObject({
      ok: true,
      value: {
        repos: [
          {
            canonical: "acme/web",
            access: "ok",
            health: "warning",
            missing: ["contents:write"],
            checkedAt: new Date(NOW.getTime() + 1001).toISOString(),
          },
          { canonical: "acme/api", access: "no_access", health: "error", permissions: null },
        ],
      },
    });
  });

  it("a repo check that fails upstream is recorded as unknown, not no_access", async () => {
    await saved(TOKEN);
    s.githubVerifier.grantRepo(TOKEN, "acme/web");
    await addRepo(s.deps, alice, { repo: "acme/web" });
    s.githubVerifier.failRepo(TOKEN, "acme/web", {
      kind: "upstream",
      service: "github",
      retryable: true,
    });
    const r = await saveGithubToken(s.deps, alice, { token: TOKEN });
    expect(r).toMatchObject({
      ok: true,
      value: { repos: [{ canonical: "acme/web", access: "unknown", health: "unknown" }] },
    });
  });
});

describe("removeGithubToken", () => {
  it("deletes the credential, records one event, keeps the repo list", async () => {
    await saved();
    s.githubVerifier.grantRepo(TOKEN, "acme/web");
    await addRepo(s.deps, alice, { repo: "acme/web" });
    const r = await removeGithubToken(s.deps, alice);
    expect(r).toMatchObject({
      ok: true,
      value: { availability: "not_configured", token: null, repos: [{ canonical: "acme/web" }] },
    });
    expect(await s.githubCredentials.get()).toBeNull();
    const [event] = await s.reviewEvents.list({ limit: 1 });
    expect(event).toMatchObject({ type: "github_token_removed", detail: { login: "octocat" } });
  });

  it("removing when nothing is stored succeeds and records nothing", async () => {
    expect((await removeGithubToken(s.deps, alice)).ok).toBe(true);
    expect(await events()).toEqual([]);
  });

  it("only a signed-in user may remove", async () => {
    await saved();
    expect(await removeGithubToken(s.deps, machine)).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
    expect(await s.githubCredentials.get()).not.toBeNull();
  });
});

describe("addRepo", () => {
  beforeEach(async () => {
    await saved();
  });

  it("checks access with the stored token and saves GitHub's spelling", async () => {
    s.githubVerifier.grantRepo(TOKEN, "Acme/Web");
    const r = await addRepo(s.deps, alice, { repo: " acme/web " });
    expect(r).toMatchObject({
      ok: true,
      value: {
        added: { canonical: "Acme/Web", access: "ok", health: "ok", missing: [] },
        warnings: [],
        view: { repos: [{ canonical: "Acme/Web" }] },
      },
    });
    expect(s.githubVerifier.calls.at(-1)).toEqual({
      method: "checkRepo",
      token: TOKEN,
      repo: "acme/web",
    });
    const [event] = await s.reviewEvents.list({ limit: 1 });
    expect(event).toMatchObject({
      type: "github_repo_added",
      actor: { kind: "user", id: "u-alice" },
      detail: { repo: "Acme/Web" },
    });
  });

  it("readable but missing write → saved, with a warning per missing permission", async () => {
    s.githubVerifier.grantRepo(TOKEN, "acme/web", READ_ONLY);
    const r = await addRepo(s.deps, alice, { repo: "acme/web" });
    expect(r).toMatchObject({
      ok: true,
      value: { added: { health: "warning" }, warnings: ["contents:write"] },
    });
  });

  it("unverified permissions are saved without a warning (health partial)", async () => {
    s.githubVerifier.grantRepo(TOKEN, "acme/web", ALL_UNVERIFIED);
    expect(await addRepo(s.deps, alice, { repo: "acme/web" })).toMatchObject({
      ok: true,
      value: { added: { health: "partial" }, warnings: [] },
    });
  });

  it.each([
    ["not_found", { kind: "not_found", entity: "repository" }],
    ["forbidden", { kind: "forbidden", reason: "x" }],
  ] as const)("no access (%s) → forbidden naming the repo, nothing saved", async (_n, error) => {
    s.githubVerifier.failRepo(TOKEN, "acme/web", error);
    const r = await addRepo(s.deps, alice, { repo: "acme/web" });
    expect(r).toEqual({
      ok: false,
      error: { kind: "forbidden", reason: "The token cannot access acme/web." },
    });
    expect(await s.githubRepos.listRepos()).toEqual([]);
    expect(await events()).toEqual(["github_token_saved"]);
  });

  it("GitHub unavailable → upstream, nothing saved", async () => {
    s.githubVerifier.failRepo(TOKEN, "acme/web", {
      kind: "upstream",
      service: "github",
      retryable: true,
    });
    expect(await addRepo(s.deps, alice, { repo: "acme/web" })).toMatchObject({
      ok: false,
      error: { kind: "upstream" },
    });
    expect(await s.githubRepos.listRepos()).toEqual([]);
  });

  it("an invalid name or a case-insensitive duplicate is rejected before calling GitHub", async () => {
    s.githubVerifier.grantRepo(TOKEN, "acme/web");
    await addRepo(s.deps, alice, { repo: "acme/web" });
    const before = s.githubVerifier.calls.length;
    expect(await addRepo(s.deps, alice, { repo: "not a repo" })).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "repo" },
    });
    expect(await addRepo(s.deps, alice, { repo: "ACME/WEB" })).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "repo", message: expect.stringContaining("already") },
    });
    expect(s.githubVerifier.calls.length).toBe(before);
  });

  it("the 51st repo is rejected", async () => {
    for (let i = 0; i < 50; i++) {
      s.githubVerifier.grantRepo(TOKEN, `acme/r${i}`);
      expect((await addRepo(s.deps, alice, { repo: `acme/r${i}` })).ok).toBe(true);
    }
    s.githubVerifier.grantRepo(TOKEN, "acme/r50");
    expect(await addRepo(s.deps, alice, { repo: "acme/r50" })).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "repo" },
    });
    expect(await s.githubRepos.listRepos()).toHaveLength(50);
  });

  it("without a usable token → not_configured github (needs_reset when undecryptable)", async () => {
    s.tokenCipher.rotate();
    expect(await addRepo(s.deps, alice, { repo: "acme/web" })).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "github", reason: "needs_reset" },
    });
    await removeGithubToken(s.deps, alice);
    expect(await addRepo(s.deps, alice, { repo: "acme/web" })).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "github" },
    });
  });

  it("only a signed-in user may add", async () => {
    expect(await addRepo(s.deps, machine, { repo: "acme/web" })).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });
});

describe("removeRepo", () => {
  it("removes case-insensitively and records one event", async () => {
    await saved();
    s.githubVerifier.grantRepo(TOKEN, "Acme/Web");
    await addRepo(s.deps, alice, { repo: "acme/web" });
    const r = await removeRepo(s.deps, alice, { repo: "acme/WEB" });
    expect(r).toMatchObject({ ok: true, value: { repos: [] } });
    const [event] = await s.reviewEvents.list({ limit: 1 });
    expect(event).toMatchObject({ type: "github_repo_removed", detail: { repo: "Acme/Web" } });
  });

  it("works without a token, and an unlisted repo → not_found", async () => {
    expect(await removeRepo(s.deps, alice, { repo: "acme/web" })).toMatchObject({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(await removeRepo(s.deps, alice, { repo: "bad name" })).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "repo" },
    });
    expect(await events()).toEqual([]);
  });

  it("only a signed-in user may remove", async () => {
    expect(await removeRepo(s.deps, machine, { repo: "acme/web" })).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });
});

describe("getSettingsView / availability", () => {
  it("not configured", async () => {
    expect(await getSettingsView(s.deps, alice)).toEqual({
      ok: true,
      value: { availability: "not_configured", token: null, repos: [], maxRepos: 50 },
    });
    expect(await getGithubAvailability(s.deps)).toEqual({ state: "not_configured" });
    expect(await resolveGithubToken(s.deps)).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "github" },
    });
  });

  it("ready: resolves the plaintext only through resolveGithubToken", async () => {
    await saved();
    const view = await getSettingsView(s.deps, alice);
    expect(view).toMatchObject({ ok: true, value: { availability: "ready" } });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(await getGithubAvailability(s.deps)).toEqual({ state: "ready", login: "octocat" });
    expect(await resolveGithubToken(s.deps)).toEqual({ ok: true, value: TOKEN });
  });

  it("an undecryptable token → needs_reset, still showing who saved it", async () => {
    await saved();
    s.tokenCipher.rotate();
    expect(await getSettingsView(s.deps, alice)).toMatchObject({
      ok: true,
      value: { availability: "needs_reset", token: { login: "octocat", last4: "WXYZ" } },
    });
    expect(await getGithubAvailability(s.deps)).toEqual({ state: "needs_reset", login: "octocat" });
    expect(await resolveGithubToken(s.deps)).toEqual({
      ok: false,
      error: { kind: "not_configured", feature: "github", reason: "needs_reset" },
    });
  });

  it("the machine actor may not read the settings view", async () => {
    expect(await getSettingsView(s.deps, machine)).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });
});

describe("a settings change and its event are one write", () => {
  it("save: when the event insert fails, the stored token does not change", async () => {
    await saved(TOKEN);
    const before = await s.githubCredentials.get();
    s.githubVerifier.acceptToken(TOKEN_2);
    s.reviewEvents.failNextAppend();
    await expect(saveGithubToken(s.deps, alice, { token: TOKEN_2 })).rejects.toThrow();
    expect(await s.githubCredentials.get()).toEqual(before);
    expect(await events()).toEqual(["github_token_saved"]);
  });

  it("first save: when the event insert fails, nothing is stored", async () => {
    s.githubVerifier.acceptToken(TOKEN);
    s.reviewEvents.failNextAppend();
    await expect(saveGithubToken(s.deps, alice, { token: TOKEN })).rejects.toThrow();
    expect(await s.githubCredentials.get()).toBeNull();
    expect(await events()).toEqual([]);
  });

  it("remove: when the event insert fails, the token stays", async () => {
    await saved();
    const before = await s.githubCredentials.get();
    s.reviewEvents.failNextAppend();
    await expect(removeGithubToken(s.deps, alice)).rejects.toThrow();
    expect(await s.githubCredentials.get()).toEqual(before);
    expect(await events()).toEqual(["github_token_saved"]);
  });

  it("add repo: when the event insert fails, the repo is not listed", async () => {
    await saved();
    s.githubVerifier.grantRepo(TOKEN, "acme/web");
    s.reviewEvents.failNextAppend();
    await expect(addRepo(s.deps, alice, { repo: "acme/web" })).rejects.toThrow();
    expect(await s.githubRepos.listRepos()).toEqual([]);
    expect(await events()).toEqual(["github_token_saved"]);
  });

  it("remove repo: when the event insert fails, the repo stays listed", async () => {
    await saved();
    s.githubVerifier.grantRepo(TOKEN, "acme/web");
    await addRepo(s.deps, alice, { repo: "acme/web" });
    s.reviewEvents.failNextAppend();
    await expect(removeRepo(s.deps, alice, { repo: "acme/web" })).rejects.toThrow();
    expect((await s.githubRepos.listRepos()).map((r) => r.canonical)).toEqual(["acme/web"]);
    expect(await events()).toEqual(["github_repo_added", "github_token_saved"]);
  });
});
