import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Test-side env hygiene (migration-plan.md stage 4, 4c). Jira and LLM credentials come from
 * `SettingsStore`; tests inject them through the settings-store fake. Env is bootstrap only.
 * Every function here handles key NAMES; values are never logged or returned.
 */

type Env = Record<string, string | undefined>;

const CREDENTIAL_KEY = /^(?:JIRA|ANTHROPIC|OPENAI)_/;

/** The keys integration setup may load from `.env.test.local`: the remote DB and Redis only. */
export const BOOTSTRAP_TEST_ENV_KEYS = ["TEST_DATABASE_URL", "TEST_REDIS_URL"] as const;

export const isCredentialEnvKey = (key: string): boolean => CREDENTIAL_KEY.test(key);

/** A copy of `env` without Jira and LLM keys, e.g. for a spawned build. */
export function withoutCredentialEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isCredentialEnvKey(key)));
}

/**
 * Deletes Jira and LLM keys from `env` in place, so a developer shell (or an SDK that falls back
 * to env, such as `ANTHROPIC_BASE_URL`) cannot feed real credentials into a test. Returns the
 * removed key names.
 */
export function scrubCredentialEnv(env: Env = process.env): string[] {
  const removed = Object.keys(env).filter(isCredentialEnvKey);
  for (const key of removed) delete env[key];
  return removed;
}

/**
 * Loads only `BOOTSTRAP_TEST_ENV_KEYS` from an env file into `target`. Other keys in the file
 * (Jira, LLM, anything else) are ignored. Like `process.loadEnvFile`, a value already set wins.
 */
export function loadBootstrapTestEnv(path: string, target: Env = process.env): void {
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const key of BOOTSTRAP_TEST_ENV_KEYS) {
    const value = parsed[key];
    if (value !== undefined && target[key] === undefined) target[key] = value;
  }
}
