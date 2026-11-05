import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../testing/fakes/memory-logger";
import { ConfigError, deprecatedKeys, loadConfig, warnDeprecatedKeys } from "./config";

const base = {
  DATABASE_URL: "postgresql://user:dbpass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "s".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
};

function fail(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected loadConfig to throw");
}

describe("required keys", () => {
  it("reports every missing required key in a single error", () => {
    const e = fail({});
    for (const k of ["DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]) {
      expect(e.message).toContain(k);
    }
    expect(e.issues.map((i) => i.key).sort()).toEqual([
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "DATABASE_URL",
      "REDIS_URL",
    ]);
  });

  it("treats blank / whitespace-only values as missing", () => {
    expect(fail({ ...base, REDIS_URL: "   " }).issues.map((i) => i.key)).toEqual(["REDIS_URL"]);
  });

  it("reports several different invalid keys at once", () => {
    const e = fail({
      ...base,
      DATABASE_URL: "not a url",
      BETTER_AUTH_SECRET: "short",
      PORT: "abc",
    });
    expect(e.issues.map((i) => i.key).toSorted()).toEqual([
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "PORT",
    ]);
  });
});

describe("secrets never leak", () => {
  it("does not echo values in the error message", () => {
    const values = {
      DATABASE_URL: "postgresql://user:LEAKPW@ho st/db",
      BETTER_AUTH_SECRET: "tooshort-LEAK1",
      REDIS_URL: "REDISLEAK1",
      BETTER_AUTH_URL: "LEAKAUTH",
      PORT: "LEAKPORT",
      HOST: "",
    };
    const e = fail(values);
    expect(e.message).not.toMatch(/LEAK/);
    expect(e.message).not.toContain("dbpass");
    expect(JSON.stringify(e.issues)).not.toMatch(/LEAK/);
    expect(e.message).toContain("DATABASE_URL");
  });
});

describe("Slack is configured on /settings, never from the environment (FR-SLACKCFG-01)", () => {
  const slackEnv = {
    SLACK_USER_TOKEN: "xoxp-LEGACY-1",
    SLACK_SIGNING_SECRET: "LEGACY-signing",
    SLACK_APP_TOKEN: "xapp-LEGACY-1",
    SLACK_REVIEW_CHANNEL_IDS: "C1,C2",
    SLACK_REVIEW_GITHUB_ACCOUNT: "LEGACY-account",
    SLACK_REVIEW_ALLOWED_USER_IDS: "U1",
    SLACK_DIGEST_MODEL: "LEGACY-model",
  };

  it("any SLACK_* variable, alone or partial, is not a config error", () => {
    for (const [key, value] of Object.entries(slackEnv)) {
      expect(() => loadConfig({ ...base, [key]: value })).not.toThrow();
    }
  });

  it("no SLACK_* value reaches the config", () => {
    const c = loadConfig({ ...base, ...slackEnv });
    expect(c).not.toHaveProperty("slack");
    expect(c).not.toHaveProperty("digest");
    expect(JSON.stringify(c)).not.toContain("LEGACY");
  });
});

describe("Jira and the LLM are configured on /settings, never from the environment", () => {
  const legacy = {
    JIRA_BASE_URL: "https://legacy.atlassian.net",
    JIRA_EMAIL: "legacy@example.com",
    JIRA_API_TOKEN: "LEGACY-jira-token",
    ANTHROPIC_API_KEY: "LEGACY-anthropic-key",
    ANTHROPIC_AUTH_TOKEN: "LEGACY-anthropic-token",
    ANTHROPIC_BASE_URL: "ftp://not-even-valid",
    ANTHROPIC_MODEL: "LEGACY-model",
    ANTHROPIC_AUTH_HEADER: "basic",
    ANTHROPIC_SERVER_FALLBACK: "maybe",
    OPENAI_API_KEY: "LEGACY-openai-key",
    OPENAI_BASE_URL: "LEGACY-url",
    OPENAI_MODEL: "LEGACY-openai-model",
    OPENAI_REASONING_EFFORT: "extreme",
  };

  it("any JIRA_*, ANTHROPIC_* or OPENAI_* variable, even partial or invalid, is not an error", () => {
    for (const [key, value] of Object.entries(legacy)) {
      expect(() => loadConfig({ ...base, [key]: value })).not.toThrow();
    }
    expect(() => loadConfig({ ...base, ...legacy })).not.toThrow();
  });

  it("no value of them reaches the config", () => {
    const c = loadConfig({ ...base, ...legacy });
    for (const key of ["jira", "anthropic", "openai"]) expect(c).not.toHaveProperty(key);
    expect(JSON.stringify(c)).not.toContain("LEGACY");
  });

  it("the config holds only the bootstrap settings", () => {
    const c = loadConfig({
      ...base,
      DATABASE_SEARCH_PATH: "app",
      REDIS_KEY_PREFIX: "p:",
      HOST: "0.0.0.0",
      PORT: "8080",
    });
    expect(Object.keys(c).toSorted()).toEqual([
      "auth",
      "databaseSearchPath",
      "databaseUrl",
      "redisKeyPrefix",
      "redisUrl",
      "server",
    ]);
  });

  it("reports them as deprecated by name, never by value", () => {
    const keys = deprecatedKeys({ ...base, ...legacy });
    expect(keys.toSorted()).toEqual(Object.keys(legacy).toSorted());
    const logger = new MemoryLogger();
    warnDeprecatedKeys({ ...base, ...legacy }, logger);
    expect(JSON.stringify(logger.entries)).not.toContain("LEGACY");
  });
});

describe("GitHub settings are not read from the environment (FR-GITHUB-08)", () => {
  const legacy = { GITHUB_REPO_ALLOWLIST: "not a list" };

  it("does not expose the legacy keys on the config", () => {
    const c = loadConfig({ ...base, GITHUB_REPO_ALLOWLIST: "acme/web" });
    expect(c).not.toHaveProperty("github");
    expect(c).not.toHaveProperty("githubRepoAllowlist");
    expect(JSON.stringify(c)).not.toContain("acme/web");
  });

  it("a partial or invalid legacy value is not a config error", () => {
    expect(() => loadConfig({ ...base, ...legacy })).not.toThrow();
  });

  it("reports them as deprecated by name", () => {
    expect(deprecatedKeys({ ...base, ...legacy })).toEqual(["GITHUB_REPO_ALLOWLIST"]);
  });
});

describe("defaults", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.redisKeyPrefix).toBe("agent-ops:");
    expect(c.server).toEqual({ port: 3000, host: "127.0.0.1" });
  });

  it("honours overrides and validates PORT range", () => {
    expect(loadConfig({ ...base, PORT: "8080", HOST: "0.0.0.0" }).server).toEqual({
      port: 8080,
      host: "0.0.0.0",
    });
    expect(fail({ ...base, PORT: "70000" }).issues.map((i) => i.key)).toEqual(["PORT"]);
  });
});

describe("trimming", () => {
  it("trims every string value", () => {
    const c = loadConfig({
      DATABASE_URL: `  ${base.DATABASE_URL}\n`,
      REDIS_URL: ` ${base.REDIS_URL} `,
      BETTER_AUTH_SECRET: `\t${base.BETTER_AUTH_SECRET}\n`,
      BETTER_AUTH_URL: ` ${base.BETTER_AUTH_URL}`,
      REDIS_KEY_PREFIX: " p: ",
    });
    expect(c.databaseUrl).toBe(base.DATABASE_URL);
    expect(c.auth.secret).toBe(base.BETTER_AUTH_SECRET);
    expect(c.redisKeyPrefix).toBe("p:");
  });
});

describe("CRON_SECRET and MACHINE_TOKEN configure nothing", () => {
  it.each(["CRON_SECRET", "MACHINE_TOKEN"])("%s never reaches the config", (key) => {
    const c = loadConfig({ ...base, [key]: "x".repeat(40) });
    expect(c).not.toHaveProperty("machineToken");
    expect(JSON.stringify(c)).not.toContain("x".repeat(40));
  });

  it("a short or blank MACHINE_TOKEN is not a config error", () => {
    expect(() => loadConfig({ ...base, MACHINE_TOKEN: "short" })).not.toThrow();
    expect(() => loadConfig({ ...base, MACHINE_TOKEN: " " })).not.toThrow();
  });

  it("MACHINE_TOKEN only triggers the deprecation warning, by name", () => {
    expect(deprecatedKeys({ ...base, MACHINE_TOKEN: "s3cret" })).toEqual(["MACHINE_TOKEN"]);
    const logger = new MemoryLogger();
    warnDeprecatedKeys({ MACHINE_TOKEN: "s3cret" }, logger);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]!.level).toBe("warn");
    expect(logger.entries[0]!.fields).toEqual({ keys: ["MACHINE_TOKEN"] });
    expect(JSON.stringify(logger.entries)).not.toContain("s3cret");
  });
});

describe("deprecatedKeys", () => {
  it("names env vars the app no longer reads, never their values", () => {
    expect(deprecatedKeys({ ...base, CRON_SECRET: "s3cret" })).toEqual(["CRON_SECRET"]);
  });
  it("ignores blank values and unrelated keys", () => {
    expect(deprecatedKeys({ ...base, CRON_SECRET: "  " })).toEqual([]);
    expect(deprecatedKeys({})).toEqual([]);
  });
  it("warns once with the key names only", () => {
    const logger = new MemoryLogger();
    warnDeprecatedKeys({ CRON_SECRET: "s3cret" }, logger);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]!.level).toBe("warn");
    expect(JSON.stringify(logger.entries)).not.toContain("s3cret");
    expect(logger.entries[0]!.fields).toEqual({ keys: ["CRON_SECRET"] });
    warnDeprecatedKeys({}, logger);
    expect(logger.entries).toHaveLength(1);
  });
  it("loadConfig does not fail when a deprecated key is set", () => {
    expect(() => loadConfig({ ...base, CRON_SECRET: "x" })).not.toThrow();
  });
});

describe("DATABASE_SEARCH_PATH", () => {
  it("is optional", () => {
    expect(loadConfig(base).databaseSearchPath).toBeUndefined();
  });
  it("accepts a lowercase schema identifier", () => {
    expect(
      loadConfig({ ...base, DATABASE_SEARCH_PATH: "test_abc123_0a1b2c3d" }).databaseSearchPath,
    ).toBe("test_abc123_0a1b2c3d");
  });
  it.each(["Public", "1abc", "a-b", 'a";drop', "a b", "a,b", "ä"])("rejects %j", (v) => {
    expect(fail({ ...base, DATABASE_SEARCH_PATH: v }).issues.map((i) => i.key)).toEqual([
      "DATABASE_SEARCH_PATH",
    ]);
  });
});
