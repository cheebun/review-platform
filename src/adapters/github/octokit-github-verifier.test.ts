import { beforeEach, describe, expect, it } from "vitest";
import type { RepoPermissions } from "../../domain/settings/permissions";
import type { TokenInfo } from "../../ports/github-verifier";
import { FAKE_GITHUB_BASE_URL } from "../../testing/http/github/handlers";
import { aVerifyRepo, VerifyWorld } from "../../testing/http/github/verify-world";
import { server } from "../../testing/http/server";
import { OctokitGitHubVerifier } from "./octokit-github-verifier";

// A fake token: a test sentinel, never a real credential.
const TOKEN = "github_pat_SENTINEL0123456789abcdefWXYZ";
const FINE: TokenInfo = { tokenKind: "fine_grained", scopes: null };
const NOW = Date.parse("2026-11-04T00:00:00Z");

let world: VerifyWorld;
const verifier = () =>
  new OctokitGitHubVerifier({
    userAgent: "agent-ops-test",
    baseUrl: FAKE_GITHUB_BASE_URL,
    now: () => NOW,
  });

beforeEach(() => {
  world = new VerifyWorld();
  server.use(...world.handlers());
});

/** Every request any test makes must be a read. */
const expectReadOnly = () => {
  expect(world.requests.length).toBeGreaterThan(0);
  for (const r of world.requests) expect(r.method).toBe("GET");
};

const perms = (
  over: Partial<{ [K in keyof RepoPermissions]: Partial<RepoPermissions[K]> }>,
): RepoPermissions => ({
  pullRequests: { read: "granted", write: "unverified", ...over.pullRequests },
  contents: { read: "granted", write: "granted", ...over.contents },
  checks: { read: "granted", ...over.checks },
  statuses: { read: "granted", ...over.statuses },
});

describe("verifyToken (GET /user)", () => {
  it("returns the login and avatar; no scope header means fine-grained", async () => {
    const result = await verifier().verifyToken(TOKEN);
    expect(result).toEqual({
      ok: true,
      value: {
        login: "octocat",
        avatarUrl: "https://avatars.example.test/u/1",
        tokenKind: "fine_grained",
        scopes: null,
      },
    });
    expect(world.requests).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/user",
        auth: expect.stringContaining(TOKEN),
      }),
    ]);
  });

  it("an X-OAuth-Scopes header means a classic token, with its scopes", async () => {
    world.scopes = "repo, read:user";
    expect(await verifier().verifyToken(TOKEN)).toMatchObject({
      ok: true,
      value: { tokenKind: "classic", scopes: ["repo", "read:user"] },
    });
  });

  it("an empty X-OAuth-Scopes header is a classic token with no scopes", async () => {
    world.scopes = "";
    expect(await verifier().verifyToken(TOKEN)).toMatchObject({
      ok: true,
      value: { tokenKind: "classic", scopes: [] },
    });
  });

  it.each<[number | "network", object]>([
    [401, { kind: "forbidden" }],
    [403, { kind: "forbidden" }],
    [502, { kind: "upstream", service: "github", retryable: true }],
    ["network", { kind: "upstream", service: "github", retryable: true }],
  ])("%s → %j, never echoing the token", async (status, error) => {
    world.userStatus = status;
    const result = await verifier().verifyToken(TOKEN);
    expect(result).toMatchObject({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("checkRepo (read-only permission probes)", () => {
  it("full access, fine-grained: reads granted, contents:write from merge settings, PR write unverified", async () => {
    world.addRepo(aVerifyRepo("Acme/Web"));
    const result = await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE);
    expect(result).toEqual({
      ok: true,
      value: { owner: "Acme", repo: "Web", canonical: "Acme/Web", permissions: perms({}) },
    });
    expectReadOnly();
    expect(world.requests.map((r) => r.path.split("?")[0])).toEqual([
      "/repos/acme/web",
      "/repos/Acme/Web/pulls",
      "/repos/Acme/Web/commits",
      "/repos/Acme/Web/commits/main/check-runs",
      "/repos/Acme/Web/commits/main/status",
    ]);
  });

  it("never returns the repo body (temp_clone_token is sensitive)", async () => {
    world.addRepo(aVerifyRepo("acme/web"));
    const result = await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE);
    expect(JSON.stringify(result)).not.toContain("TEMPCLONE-SENTINEL");
  });

  it("fine-grained without merge settings but with contents:read → contents:write missing", async () => {
    world.addRepo(aVerifyRepo("acme/web", { mergeSettings: false }));
    expect(await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE)).toMatchObject({
      ok: true,
      value: { permissions: perms({ contents: { write: "missing" } }) },
    });
  });

  it("fine-grained, no merge settings and contents:read unknown → contents:write unverified", async () => {
    world.addRepo(aVerifyRepo("acme/web", { mergeSettings: false, commits: 502 }));
    expect(await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE)).toMatchObject({
      ok: true,
      value: {
        permissions: perms({ contents: { read: "unverified", write: "unverified" } }),
      },
    });
  });

  it("a user without push on the repo → contents:write missing", async () => {
    world.addRepo(
      aVerifyRepo("acme/web", { permissions: { admin: false, push: false, pull: true } }),
    );
    expect(await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE)).toMatchObject({
      ok: true,
      value: { permissions: perms({ contents: { write: "missing" } }) },
    });
  });

  it("403 on each read probe → missing", async () => {
    world.addRepo(
      aVerifyRepo("acme/web", {
        pulls: 403,
        commits: 403,
        checkRuns: 403,
        combinedStatus: 403,
        mergeSettings: false,
      }),
    );
    expect(await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE)).toMatchObject({
      ok: true,
      value: {
        permissions: {
          pullRequests: { read: "missing", write: "unverified" },
          contents: { read: "missing", write: "unverified" },
          checks: { read: "missing" },
          statuses: { read: "missing" },
        },
      },
    });
  });

  it("an empty repo: commits 409 proves contents:read; ref probes 404/422 are unverified", async () => {
    world.addRepo(aVerifyRepo("acme/web", { commits: 409, checkRuns: 404, combinedStatus: 422 }));
    expect(await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE)).toMatchObject({
      ok: true,
      value: {
        permissions: perms({ checks: { read: "unverified" }, statuses: { read: "unverified" } }),
      },
    });
  });

  it("5xx or a dropped connection on a probe → unverified, not missing", async () => {
    world.addRepo(aVerifyRepo("acme/web", { pulls: 502, checkRuns: "network" }));
    expect(await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE)).toMatchObject({
      ok: true,
      value: {
        permissions: perms({
          pullRequests: { read: "unverified" },
          checks: { read: "unverified" },
        }),
      },
    });
  });

  describe("classic tokens (scopes from X-OAuth-Scopes)", () => {
    it("repo scope + push → both writes granted", async () => {
      world.addRepo(aVerifyRepo("acme/web"));
      expect(
        await verifier().checkRepo(
          TOKEN,
          { owner: "acme", repo: "web" },
          { tokenKind: "classic", scopes: ["repo"] },
        ),
      ).toMatchObject({
        ok: true,
        value: { permissions: perms({ pullRequests: { write: "granted" } }) },
      });
    });

    it("no repo scope on a private repo → both writes missing", async () => {
      world.addRepo(aVerifyRepo("acme/web"));
      expect(
        await verifier().checkRepo(
          TOKEN,
          { owner: "acme", repo: "web" },
          { tokenKind: "classic", scopes: ["read:user", "public_repo"] },
        ),
      ).toMatchObject({
        ok: true,
        value: {
          permissions: perms({
            pullRequests: { write: "missing" },
            contents: { write: "missing" },
          }),
        },
      });
    });

    it("public_repo on a public repo + push → writes granted", async () => {
      world.addRepo(aVerifyRepo("acme/web", { private: false }));
      expect(
        await verifier().checkRepo(
          TOKEN,
          { owner: "acme", repo: "web" },
          { tokenKind: "classic", scopes: ["public_repo"] },
        ),
      ).toMatchObject({
        ok: true,
        value: { permissions: perms({ pullRequests: { write: "granted" } }) },
      });
    });

    it("repo scope without push → writes missing; no permissions object → unverified", async () => {
      world.addRepo(
        aVerifyRepo("acme/web", { permissions: { admin: false, push: false, pull: true } }),
      );
      world.addRepo(aVerifyRepo("acme/api", { permissions: undefined }));
      const classic: TokenInfo = { tokenKind: "classic", scopes: ["repo"] };
      expect(
        await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, classic),
      ).toMatchObject({
        ok: true,
        value: {
          permissions: perms({
            pullRequests: { write: "missing" },
            contents: { write: "missing" },
          }),
        },
      });
      expect(
        await verifier().checkRepo(TOKEN, { owner: "acme", repo: "api" }, classic),
      ).toMatchObject({
        ok: true,
        value: {
          permissions: perms({
            pullRequests: { write: "unverified" },
            contents: { write: "unverified" },
          }),
        },
      });
    });
  });

  it.each<[number | "network", string]>([
    [404, "not_found"],
    [403, "forbidden"],
    [401, "forbidden"],
    [503, "upstream"],
    ["network", "upstream"],
  ])("repo request %s → %s, and no probe runs", async (status, kind) => {
    world.addRepo(aVerifyRepo("acme/web", { status }));
    const result = await verifier().checkRepo(TOKEN, { owner: "acme", repo: "web" }, FINE);
    expect(result).toMatchObject({ ok: false, error: { kind } });
    expect(world.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("a repo the token cannot see at all (unknown name) → not_found", async () => {
    expect(await verifier().checkRepo(TOKEN, { owner: "acme", repo: "ghost" }, FINE)).toMatchObject(
      { ok: false, error: { kind: "not_found" } },
    );
    expectReadOnly();
  });
});
