import { beforeEach, describe, expect, it } from "vitest";
import { SETUP_ATTEMPT_POLICY } from "../application/identity/setup";
import { ANTHROPIC_KEY } from "../application/settings/llm-testing";
import { USER_TOKEN } from "../application/settings/slack-testing";
import { TOKEN as GITHUB_TOKEN } from "../application/settings/testing";
import { createTestContainer } from "../testing/container";
import type { FakeAuth } from "../testing/fakes/fake-auth";
import type { FakeGitHubVerifier } from "../testing/fakes/fake-github-verifier";
import type { FakeSlackVerifier } from "../testing/fakes/fake-slack-verifier";
import type { MemoryLogger } from "../testing/fakes/memory-logger";
import {
  MAX_SETUP_INPUT,
  parseFinishSetupBody,
  parseGithubTokenBody,
  parseSetupAnthropicBody,
  parseSlackTokenBody,
  runFinishSetup,
  runGetSetupSections,
  runListSetupGithubRepos,
  runTestSetupAnthropic,
  runTestSetupSlack,
  type SetupFnPorts,
} from "./setup.logic";

const LOGIN = "correct horse battery";
const IP = "203.0.113.9";
const headers = new Headers();

let ports: SetupFnPorts;
let auth: FakeAuth;
let logger: MemoryLogger;

beforeEach(() => {
  ports = createTestContainer().ports;
  auth = ports.auth as FakeAuth;
  logger = ports.logger as MemoryLogger;
  (ports.githubVerifier as FakeGitHubVerifier).acceptToken(GITHUB_TOKEN);
  (ports.slackVerifier as FakeSlackVerifier).userToken(USER_TOKEN);
});

const finish = (data = { token: LOGIN, confirm: LOGIN }) =>
  runFinishSetup(ports, data, IP, headers);

function message(parse: (input: unknown) => unknown, input: unknown): string {
  try {
    parse(input);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("validators", () => {
  it("accept the documented shapes verbatim", () => {
    const body = {
      token: " a ",
      confirm: " a ",
      anthropic: { apiKey: "k", baseUrl: "https://x.test", model: "m" },
      github: { token: "t", repos: ["a/b"] },
      slack: { userToken: "xoxp-1", signingSecret: "abc" },
    };
    expect(parseFinishSetupBody(body)).toEqual(body);
    expect(parseFinishSetupBody({ token: "a", confirm: "a" })).toEqual({
      token: "a",
      confirm: "a",
    });
    expect(parseSetupAnthropicBody({ authToken: "t" })).toEqual({ authToken: "t" });
    expect(parseGithubTokenBody({ token: "t" })).toEqual({ token: "t" });
    expect(parseSlackTokenBody({ userToken: "t" })).toEqual({ userToken: "t" });
  });

  it("reject other shapes with a fixed message that never echoes the input", () => {
    const huge = "x".repeat(MAX_SETUP_INPUT + 1);
    const cases: Array<[(i: unknown) => unknown, unknown]> = [
      [parseFinishSetupBody, undefined],
      [parseFinishSetupBody, { token: LOGIN }],
      [parseFinishSetupBody, { token: LOGIN, confirm: LOGIN, extra: 1 }],
      [parseFinishSetupBody, { token: huge, confirm: huge }],
      [parseFinishSetupBody, { token: LOGIN, confirm: LOGIN, github: { token: LOGIN } }],
      [parseFinishSetupBody, { token: LOGIN, confirm: LOGIN, slack: { userToken: 1 } }],
      [parseFinishSetupBody, { token: LOGIN, confirm: LOGIN, anthropic: { key: LOGIN } }],
      [parseSetupAnthropicBody, { apiKey: huge }],
      [parseGithubTokenBody, { token: LOGIN, repos: [] }],
      [parseSlackTokenBody, {}],
    ];
    for (const [parse, input] of cases) {
      const text = message(parse, input);
      expect(text).toMatch(/^Invalid [a-z ]+\.$/);
      expect(text).not.toContain(LOGIN);
    }
  });
});

describe("runFinishSetup", () => {
  it("is 200 and signs the owner in", async () => {
    expect(await finish()).toEqual({ result: { ok: true, value: null }, status: 200 });
    expect(auth.signIns).toHaveLength(1);
  });

  it("maps a section failure to 400 with the field path and its domain message", async () => {
    const reply = await runFinishSetup(
      ports,
      { token: LOGIN, confirm: LOGIN, slack: { userToken: "xoxb-nope" } },
      IP,
      headers,
    );
    expect(reply.status).toBe(400);
    expect(reply.result).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "slack.userToken", fieldMessage: expect.any(String) },
    });
  });

  it("maps a provider rejection to 403 on the field, with the fixed reason", async () => {
    const reply = await runFinishSetup(
      ports,
      {
        token: LOGIN,
        confirm: LOGIN,
        github: { token: "ghp_unknownSENTINEL0123456789abcdef", repos: [] },
      },
      IP,
      headers,
    );
    expect(reply.status).toBe(403);
    expect(reply.result).toMatchObject({
      ok: false,
      error: { field: "github.token", fieldMessage: "Token rejected by GitHub." },
    });
  });

  it("is 409 already initialized", async () => {
    await finish();
    const reply = await finish();
    expect(reply.status).toBe(409);
    expect(reply.result).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });

  it("is 429 with Retry-After over the per-IP limit", async () => {
    for (let i = 0; i < SETUP_ATTEMPT_POLICY.limit; i++) {
      await finish({ token: LOGIN, confirm: "x" });
    }
    const reply = await finish();
    expect(reply.status).toBe(429);
    expect(reply.headers?.["Retry-After"]).toMatch(/^\d+$/);
    expect(reply.result).toMatchObject({
      ok: false,
      error: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it("an unexpected failure is a generic 500, logged without the input", async () => {
    ports.setupUnitOfWork.run = async () => {
      throw new Error(`boom ${LOGIN} ${ANTHROPIC_KEY}`);
    };
    const reply = await runFinishSetup(
      ports,
      { token: LOGIN, confirm: LOGIN, anthropic: { apiKey: ANTHROPIC_KEY } },
      IP,
      headers,
    );
    expect(reply.status).toBe(500);
    expect(reply.result).toMatchObject({ ok: false, error: { kind: "internal" } });
    const text = JSON.stringify(logger.entries);
    expect(text).not.toContain(LOGIN);
    expect(text).not.toContain(ANTHROPIC_KEY);
    expect(logger.entries.some((e) => e.fields.fn === "finishSetup")).toBe(true);
  });
});

describe("setup-only checks", () => {
  it("return their value with 200 before setup", async () => {
    expect(await runGetSetupSections(ports, IP)).toEqual({
      result: { ok: true, value: { anthropic: false, github: false, slack: false } },
      status: 200,
    });
    expect(
      (await runTestSetupAnthropic(ports, { apiKey: ANTHROPIC_KEY }, IP)).result,
    ).toMatchObject({ ok: true, value: { verdict: "verified" } });
    expect(
      (await runListSetupGithubRepos(ports, { token: GITHUB_TOKEN }, IP)).result,
    ).toMatchObject({ ok: true, value: { login: "octocat" } });
    expect((await runTestSetupSlack(ports, { userToken: USER_TOKEN }, IP)).result).toEqual({
      ok: true,
      value: { teamName: "Acme" },
    });
  });

  it("are 409 once initialized", async () => {
    await finish();
    const replies = [
      await runGetSetupSections(ports, IP),
      await runTestSetupAnthropic(ports, { apiKey: ANTHROPIC_KEY }, IP),
      await runListSetupGithubRepos(ports, { token: GITHUB_TOKEN }, IP),
      await runTestSetupSlack(ports, { userToken: USER_TOKEN }, IP),
    ];
    for (const reply of replies) expect(reply.status).toBe(409);
  });
});
