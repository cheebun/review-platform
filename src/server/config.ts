/**
 * The ONLY module allowed to read `process.env`. Parsed once at boot.
 *
 * Error messages name the env var and the reason only. They must never echo a value.
 */
import { z } from "zod";
import type { Logger } from "../ports/system";

export interface ConfigIssue {
  key: string;
  reason: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration (${issues.length} problem${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((i) => `- ${i.key}: ${i.reason}`).join("\n"),
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/*
 * The bootstrap settings only. GitHub, Slack and the LLM provider are not configuration:
 * their credentials and values live in the encrypted settings store and are set on /settings,
 * read per call (FR-SETTINGS-01).
 */
export interface Config {
  databaseUrl: string;
  /** Optional schema for the pool (tests point a spawned server at a per-run schema). */
  databaseSearchPath?: string;
  redisUrl: string;
  redisKeyPrefix: string;
  auth: { secret: string; url: string };
  server: { port: number; host: string };
}

const url = (protocols: RegExp) => z.url({ protocol: protocols, hostname: z.regexes.hostname });
const dbUrl = url(/^postgres(?:ql)?$/);
const redisUrl = url(/^rediss?$/);
const httpUrl = url(/^https?$/);
const secret32 = z.string().min(32, "must be at least 32 characters");
const nonEmpty = z.string().min(1);
const port = z.coerce.number().int().min(1).max(65535);

type Env = Record<string, string | undefined>;

class Reader {
  readonly issues: ConfigIssue[] = [];
  constructor(private readonly env: Env) {}

  /** Trimmed value; blank counts as unset. */
  raw(key: string): string | undefined {
    const v = this.env[key]?.trim();
    return v ? v : undefined;
  }

  has(key: string): boolean {
    return this.raw(key) !== undefined;
  }

  private fail(key: string, reason: string): undefined {
    this.issues.push({ key, reason });
    return undefined;
  }

  /** Validates one key. Reasons come from zod issue messages, which never include the input. */
  parse<T>(key: string, schema: z.ZodType<T>, fallback?: T): T | undefined {
    const v = this.raw(key);
    if (v === undefined) return fallback;
    const res = schema.safeParse(v);
    if (res.success) return res.data;
    return this.fail(key, res.error.issues.map((i) => i.message).join("; "));
  }

  require<T>(key: string, schema: z.ZodType<T>): T | undefined {
    if (!this.has(key)) return this.fail(key, "is required");
    return this.parse(key, schema);
  }
}

/**
 * Env vars that older deployments set and the app no longer reads. The repo list (FR-GITHUB-08),
 * and Anthropic settings (FR-LLMCFG-01) live in the settings store. Retired Jira and OpenAI
 * variables stay deprecated; there is no import from env.
 */
const DEPRECATED_KEYS = [
  "CRON_SECRET",
  "MACHINE_TOKEN",
  "GITHUB_REPO_ALLOWLIST",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_AUTH_HEADER",
  "ANTHROPIC_SERVER_FALLBACK",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_REASONING_EFFORT",
] as const;

/** Names (never values) of set env vars the app no longer reads. Pure. */
export function deprecatedKeys(env: Env): string[] {
  return DEPRECATED_KEYS.filter((k) => (env[k]?.trim() ?? "") !== "");
}

/** Boot-time warning for `deprecatedKeys`. Warns, never fails. */
export function warnDeprecatedKeys(env: Env, logger: Logger): void {
  const keys = deprecatedKeys(env);
  if (keys.length > 0) {
    logger.warn("ignoring environment variables the app no longer reads", { keys });
  }
}

export function loadConfig(env: Env = process.env): Config {
  const r = new Reader(env);

  const databaseUrl = r.require("DATABASE_URL", dbUrl);
  const redis = r.require("REDIS_URL", redisUrl);
  const authSecret = r.require("BETTER_AUTH_SECRET", secret32);
  const authUrl = r.require("BETTER_AUTH_URL", httpUrl);
  const searchPath = r.parse(
    "DATABASE_SEARCH_PATH",
    z.string().regex(/^[a-z_][a-z0-9_]*$/, "must match ^[a-z_][a-z0-9_]*$"),
  );
  const redisKeyPrefix = r.parse("REDIS_KEY_PREFIX", nonEmpty, "agent-ops:");
  const serverPort = r.parse("PORT", port, 3000);
  const host = r.parse("HOST", nonEmpty, "127.0.0.1");

  if (r.issues.length > 0) throw new ConfigError(r.issues);

  return {
    databaseUrl: databaseUrl!,
    databaseSearchPath: searchPath,
    redisUrl: redis!,
    redisKeyPrefix: redisKeyPrefix!,
    auth: { secret: authSecret!, url: authUrl! },
    server: { port: serverPort!, host: host! },
  };
}
