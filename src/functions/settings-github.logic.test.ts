import { beforeEach, describe, expect, it } from "vitest";
import { saveGithubToken } from "../application/settings/github-token";
import { alice, machine, settingsSetup, TOKEN } from "../application/settings/testing";
import { FakeGitHub } from "../testing/fakes/fake-github";
import { runListGithubAccessibleRepos, type GithubReposFnPorts } from "./settings-github.logic";

let s: ReturnType<typeof settingsSetup>;
let github: FakeGitHub;
let ports: GithubReposFnPorts;

beforeEach(() => {
  s = settingsSetup();
  github = new FakeGitHub();
  ports = { ...s.deps, github };
});

const saved = async () => {
  s.githubVerifier.acceptToken(TOKEN);
  expect((await saveGithubToken(s.deps, alice, { token: TOKEN })).ok).toBe(true);
};

describe("runListGithubAccessibleRepos", () => {
  it("returns names, flags and truncated only", async () => {
    await saved();
    github.world.addAccessibleRepo({ fullName: "acme/web", private: true, canPush: false });
    github.world.addAccessibleRepo({ fullName: "acme/old", archived: true });
    const r = await runListGithubAccessibleRepos(ports, alice);
    expect(r).toEqual({
      ok: true,
      value: { repos: [{ fullName: "acme/web", private: true, canPush: false }], truncated: false },
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("no token: a not_configured body with a request id", async () => {
    const r = await runListGithubAccessibleRepos(ports, alice);
    expect(r).toMatchObject({ ok: false, error: { kind: "not_configured" } });
    expect(!r.ok && r.error.requestId).toEqual(expect.any(String));
    expect(!r.ok && r.error.reason).toBeUndefined();
  });

  it("an undecryptable token carries reason needs_reset", async () => {
    await saved();
    s.tokenCipher.rotate();
    expect(await runListGithubAccessibleRepos(ports, alice)).toMatchObject({
      ok: false,
      error: { kind: "not_configured", reason: "needs_reset" },
    });
  });

  it("a machine actor gets forbidden", async () => {
    expect(await runListGithubAccessibleRepos(ports, machine)).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });

  it("a rejected token is forbidden with no field (it is not a form input here)", async () => {
    await saved();
    github.world.failNext({ kind: "unauthorized" });
    const r = await runListGithubAccessibleRepos(ports, alice);
    expect(r).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(!r.ok && r.error.field).toBeUndefined();
  });

  it("maps a thrown error to internal and logs no secret", async () => {
    await saved();
    const boom = new Error(`boom ${TOKEN}`);
    ports = {
      ...ports,
      github: {
        listAccessibleRepos: () => Promise.reject(boom),
      },
    };
    const r = await runListGithubAccessibleRepos(ports, alice);
    expect(r).toMatchObject({ ok: false, error: { kind: "internal" } });
    expect(JSON.stringify([r, s.logger.entries])).not.toContain(TOKEN);
    expect(s.logger.entries.some((e) => e.msg === "settings server function failed")).toBe(true);
  });
});
