/**
 * Checks the LLM provider saved on /settings with ONE minimal request through the real adapter:
 *   pnpm llm:ping
 * Reads the provider from the database (FR-LLMCFG-01), not from LLM env variables: Anthropic if
 * configured, otherwise OpenAI. Needs only DATABASE_URL, BETTER_AUTH_SECRET (the key that
 * encrypts the stored secrets) and optionally DATABASE_SEARCH_PATH.
 * Prints the provider, the base-URL host, the model, the auth header mode, the HTTP status (or the
 * mapped error kind) and the latency. Never prints a key, a full URL or a response body.
 * Exit 0 on success, 1 otherwise.
 */
import { createSecretCiphers } from "../src/adapters/crypto/aes-gcm-token-cipher";
import { createPgDb, redactUrl } from "../src/adapters/db/client";
import { PgSettingsStore } from "../src/adapters/db/pg-settings-store";
import { formatPingReport, runLlmPingFromSettings } from "../src/adapters/llm/ping";
import { loadLocalEnv } from "../src/server/local-env";

type PingEnv = { databaseUrl: string; searchPath?: string; secret: string };

/** The three variables this script needs; problems name the variable, never its value. */
function readPingEnv(
  env: NodeJS.ProcessEnv,
): { ok: true; value: PingEnv } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const databaseUrl = env["DATABASE_URL"]?.trim() ?? "";
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL: must be a postgres:// URL");
  }
  const secret = env["BETTER_AUTH_SECRET"] ?? "";
  if (secret.length < 32) problems.push("BETTER_AUTH_SECRET: must be at least 32 characters");
  const searchPath = env["DATABASE_SEARCH_PATH"]?.trim() || undefined;
  if (searchPath !== undefined && !/^[a-z_][a-z0-9_]*$/.test(searchPath)) {
    problems.push("DATABASE_SEARCH_PATH: must match ^[a-z_][a-z0-9_]*$");
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { databaseUrl, secret, ...(searchPath ? { searchPath } : {}) } };
}

async function main(): Promise<number> {
  loadLocalEnv({ cwd: process.cwd() });
  const env = readPingEnv(process.env);
  if (!env.ok) {
    console.error(`Invalid configuration:\n  ${env.problems.join("\n  ")}`);
    return 1;
  }
  const { databaseUrl, searchPath, secret } = env.value;
  const pg = createPgDb({ url: databaseUrl, ...(searchPath ? { searchPath } : {}), max: 1 });
  try {
    const store = new PgSettingsStore(pg.db, createSecretCiphers({ secret }));
    const result = await runLlmPingFromSettings(store);
    if (result.kind === "not_configured") {
      console.error(
        result.reason === "needs_reset"
          ? "The saved LLM settings need a reset (a secret cannot be decrypted or a value is invalid). Save them again on /settings."
          : "LLM is not configured: save Anthropic or OpenAI credentials on /settings.",
      );
      return 1;
    }
    console.log(formatPingReport(result.report));
    return result.report.outcome.kind === "ok" ? 0 : 1;
  } catch (error) {
    // Store failures: the message may carry the connection string, so redact it.
    const text = error instanceof Error ? error.message : "unknown error";
    console.error(`llm:ping failed: ${redactUrl(text, databaseUrl)}`);
    return 1;
  } finally {
    await pg.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error("llm:ping failed unexpectedly.");
    process.exit(1);
  },
);
