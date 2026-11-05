import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../domain/shared/actor";
import type { Ports } from "../server/container";
import { createTestContainer } from "../testing/container";
import type { FakeGitHubVerifier } from "../testing/fakes/fake-github-verifier";
import type { FakeTokenCipher } from "../testing/fakes/fake-token-cipher";
import type { MemoryLogger } from "../testing/fakes/memory-logger";
import {
  loadSettings,
  parseRepoBody,
  parseTokenBody,
  runAddRepo,
  runRemoveGithubToken,
  runRemoveRepo,
  runSaveGithubToken,
} from "./settings.logic";

// A test sentinel, never a real credential.
const TOKEN = "github_pat_LOGICSENTINEL0123456789abcdefLAST";
const user: Actor = { kind: "user", userId: "u1", email: "a@example.com" };

let ports: Ports;
let verifier: FakeGitHubVerifier;
beforeEach(() => {
  ports = createTestContainer().ports;
  verifier = ports.githubVerifier as FakeGitHubVerifier;
});

describe("validators", () => {
  it("parseTokenBody keeps only a bounded string token", () => {
    expect(parseTokenBody({ token: " t ", extra: 1 })).toEqual({ token: " t " });
    for (const bad of [undefined, null, "x", { token: 1 }, { token: "x".repeat(2001) }]) {
      expect(() => parseTokenBody(bad)).toThrow();
    }
  });

  it("parseRepoBody keeps only a bounded string repo", () => {
    expect(parseRepoBody({ repo: "acme/web", x: 1 })).toEqual({ repo: "acme/web" });
    for (const bad of [undefined, [], { repo: 1 }, { repo: "x".repeat(501) }]) {
      expect(() => parseRepoBody(bad)).toThrow();
    }
  });

  it("a validator error never echoes the token", () => {
    let caught: unknown;
    try {
      parseTokenBody({ token: `${TOKEN}${"x".repeat(2000)}` });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(TOKEN);
  });
});

describe("settings server function logic", () => {
  it("never returns the token, its ciphertext or a log line with it, on any path", async () => {
    const responses: unknown[] = [];
    responses.push(await loadSettings(ports, user));
    responses.push(await runSaveGithubToken(ports, user, { token: TOKEN })); // rejected
    verifier.acceptToken(TOKEN);
    responses.push(await runSaveGithubToken(ports, user, { token: TOKEN }));
    expect(responses.at(-1)).toMatchObject({ ok: true, value: { availability: "ready" } });
    verifier.grantRepo(TOKEN, "acme/web");
    responses.push(await runAddRepo(ports, user, { repo: "acme/web" }));
    expect(responses.at(-1)).toMatchObject({ ok: true });
    responses.push(await runAddRepo(ports, user, { repo: "acme/ghost" }));
    responses.push(await loadSettings(ports, user));
    (ports.tokenCipher as FakeTokenCipher).rotate();
    responses.push(await loadSettings(ports, user));
    responses.push(await runAddRepo(ports, user, { repo: "acme/api" }));
    responses.push(await runRemoveRepo(ports, user, { repo: "acme/web" }));
    responses.push(await runRemoveGithubToken(ports, user));

    const row = await ports.githubCredentials.get();
    expect(row).toBeNull();
    const serialized = JSON.stringify(responses);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain(TOKEN.slice(0, -4));
    expect(JSON.stringify((ports.logger as MemoryLogger).entries)).not.toContain(TOKEN);
    expect(JSON.stringify(await ports.reviewEvents.list({ limit: 50 }))).not.toContain(TOKEN);
  });

  it("a form error carries the field and its fixed domain message", async () => {
    expect(await runSaveGithubToken(ports, user, { token: "short" })).toEqual({
      ok: false,
      error: {
        kind: "validation",
        message: "The request is invalid.",
        requestId: expect.any(String),
        field: "token",
        fieldMessage: expect.stringContaining("characters"),
      },
    });
  });

  it("a rejected token or an unreachable repo is a 403 shown on its field", async () => {
    expect(await runSaveGithubToken(ports, user, { token: TOKEN })).toEqual({
      ok: false,
      error: {
        kind: "forbidden",
        message: "You are not allowed to perform this action.",
        requestId: expect.any(String),
        field: "token",
        fieldMessage: "Token rejected by GitHub.",
      },
    });
    verifier.acceptToken(TOKEN);
    await runSaveGithubToken(ports, user, { token: TOKEN });
    expect(await runAddRepo(ports, user, { repo: "acme/ghost" })).toMatchObject({
      ok: false,
      error: {
        kind: "forbidden",
        field: "repo",
        fieldMessage: "The token cannot access acme/ghost.",
      },
    });
  });

  it("not_configured github carries needs_reset", async () => {
    verifier.acceptToken(TOKEN);
    await runSaveGithubToken(ports, user, { token: TOKEN });
    (ports.tokenCipher as FakeTokenCipher).rotate();
    expect(await runAddRepo(ports, user, { repo: "acme/web" })).toMatchObject({
      ok: false,
      error: { kind: "not_configured", reason: "needs_reset" },
    });
  });

  it("logs the Postgres code behind a DrizzleQueryError, never the query or params", async () => {
    ports.githubRepos.listRepos = async () => {
      const pg = Object.assign(new Error('relation "github_repo" does not exist'), {
        name: "PostgresError",
        code: "42P01",
      });
      const e = Object.assign(new Error(`Failed query: select 1\nparams: ${TOKEN}`), {
        name: "DrizzleQueryError",
        params: [TOKEN],
        cause: pg,
      });
      throw e;
    };
    await loadSettings(ports, user);
    const entries = (ports.logger as MemoryLogger).entries;
    const entry = entries.find((e) => e.msg === "settings server function failed");
    expect(entry?.fields).toMatchObject({
      fn: "fetchSettings",
      error: "DrizzleQueryError",
      causeCode: "42P01",
      causeMessage: 'relation "github_repo" does not exist',
    });
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
    expect(JSON.stringify(entries)).not.toContain("Failed query");
  });

  it("an unexpected throw becomes internal; details only in the log", async () => {
    ports.githubRepos.listRepos = async () => {
      throw new Error("pg://secret-host down");
    };
    const r = await loadSettings(ports, user);
    expect(r).toEqual({
      ok: false,
      error: { kind: "internal", message: "Internal server error.", requestId: expect.any(String) },
    });
    expect(JSON.stringify(r)).not.toContain("secret-host");
    expect(
      (ports.logger as MemoryLogger).entries.some(
        (e) => e.msg === "settings server function failed",
      ),
    ).toBe(true);
  });
});
