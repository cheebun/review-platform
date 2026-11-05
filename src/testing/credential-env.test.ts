import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_TEST_ENV_KEYS,
  isCredentialEnvKey,
  loadBootstrapTestEnv,
  scrubCredentialEnv,
  withoutCredentialEnv,
} from "./credential-env";

// Obviously fake sentinels, never real credentials.
const FAKE = "fake-credential-value-0001";

describe("isCredentialEnvKey", () => {
  it("matches the Jira and LLM namespaces only", () => {
    for (const key of ["JIRA_API_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_MODEL"])
      expect(isCredentialEnvKey(key)).toBe(true);
    for (const key of ["TEST_DATABASE_URL", "TEST_REDIS_URL", "PATH", "MY_JIRA_X", "JIRA"])
      expect(isCredentialEnvKey(key)).toBe(false);
  });
});

describe("withoutCredentialEnv / scrubCredentialEnv", () => {
  it("copies everything except credential keys", () => {
    const env = { PATH: "/bin", JIRA_EMAIL: FAKE, OPENAI_API_KEY: FAKE, NODE_ENV: "test" };
    expect(withoutCredentialEnv(env)).toEqual({ PATH: "/bin", NODE_ENV: "test" });
    expect(env.JIRA_EMAIL).toBe(FAKE);
  });

  it("deletes credential keys in place and returns only their names", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/bin",
      ANTHROPIC_AUTH_TOKEN: FAKE,
      JIRA_BASE_URL: FAKE,
    };
    expect(scrubCredentialEnv(env).toSorted()).toEqual(["ANTHROPIC_AUTH_TOKEN", "JIRA_BASE_URL"]);
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("loadBootstrapTestEnv", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const file = (content: string) => {
    dir = mkdtempSync(join(tmpdir(), "bootstrap-env-"));
    const path = join(dir, "env");
    writeFileSync(path, content);
    return path;
  };

  it("loads only the DB and Redis bootstrap keys, never Jira or LLM credentials", () => {
    const path = file(
      [
        "TEST_DATABASE_URL=pg://fake-host/db",
        "TEST_REDIS_URL=rediss://fake-host:6379",
        `ANTHROPIC_API_KEY=${FAKE}`,
        `OPENAI_API_KEY=${FAKE}`,
        `JIRA_API_TOKEN=${FAKE}`,
        "SOMETHING_ELSE=x",
      ].join("\n"),
    );
    const target: Record<string, string | undefined> = {};
    loadBootstrapTestEnv(path, target);
    expect(target).toEqual({
      TEST_DATABASE_URL: "pg://fake-host/db",
      TEST_REDIS_URL: "rediss://fake-host:6379",
    });
    expect(BOOTSTRAP_TEST_ENV_KEYS).toEqual(["TEST_DATABASE_URL", "TEST_REDIS_URL"]);
  });

  it("does not override a value already set (process.loadEnvFile semantics)", () => {
    const path = file("TEST_REDIS_URL=rediss://from-file:6379\n");
    const target: Record<string, string | undefined> = { TEST_REDIS_URL: "rediss://shell:6379" };
    loadBootstrapTestEnv(path, target);
    expect(target.TEST_REDIS_URL).toBe("rediss://shell:6379");
  });
});
