import { validateLoginTokenInput } from "../../domain/identity/login-token";
import { parseTokenInput } from "../../domain/settings/github-credential";
import { MAX_REPOS, parseRepoEntry, repoKey } from "../../domain/settings/repo-entry";
import { parseSlackSecret, type SlackSecretKind } from "../../domain/settings/slack-settings";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { AttemptLimiter, AttemptPolicy } from "../../ports/attempt-limiter";
import type { AuthPort } from "../../ports/auth";
import type { CredentialStore } from "../../ports/credential-store";
import type { GitHubPort } from "../../ports/github";
import type { GitHubVerifier, RepoCheckResult, VerifiedToken } from "../../ports/github-verifier";
import type { LlmProbe } from "../../ports/llm-probe";
import type { LoginTokenHasher } from "../../ports/login-token-hasher";
import { ALREADY_INITIALIZED, type LoginTokenStore } from "../../ports/login-token-store";
import type { SettingsRepo } from "../../ports/settings-repo";
import type { SettingsStore } from "../../ports/settings-store";
import type { SetupUnitOfWork } from "../../ports/setup-unit-of-work";
import type { SlackVerifier } from "../../ports/slack-verifier";
import type { Clock, IdGenerator, Logger } from "../../ports/system";
import type { TokenCipher } from "../../ports/token-cipher";
import type { WakeUp } from "../../ports/wake-up";
import type { AccessibleRepoOption } from "../settings/github-repos";
import { storeGithubToken } from "../settings/github-token";
import {
  prepareAnthropic,
  probeAnthropic,
  writeAnthropicSettings,
  type LlmProbeView,
  type PreparedAnthropic,
} from "../settings/llm-settings";
import { storeRepo } from "../settings/repos";
import {
  checkSlackSecret,
  publishSlackSettingsChanged,
  storeSlackSecret,
  type CheckedSlackSecret,
} from "../settings/slack-settings";

/**
 * First-run setup (FR-AUTH-01). Before the login token exists the wizard collects every value in
 * the browser; `finishSetup` validates all of it, then writes the token hash, the owner user and
 * the provided settings sections in ONE transaction, and signs the owner in. The setup-only
 * checks help the wizard before that and write nothing. Every call here is anonymous, so each
 * one is `conflict` once the token exists and counts toward a per-IP limit. Secrets and the
 * token are never logged or returned.
 */

/** Field names match the container's `Ports`. */
export type SetupDeps = {
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  auth: AuthPort;
  loginTokens: LoginTokenStore;
  loginTokenHasher: LoginTokenHasher;
  attemptLimiter: AttemptLimiter;
  settingsStore: SettingsStore;
  githubCredentials: CredentialStore;
  githubRepos: SettingsRepo;
  tokenCipher: TokenCipher;
  githubVerifier: GitHubVerifier;
  githubClient: (token: string) => Pick<GitHubPort, "listAccessibleRepos">;
  slackVerifier: SlackVerifier;
  llmProbe: LlmProbe;
  wakeUp: WakeUp;
  setupUnitOfWork: SetupUnitOfWork;
};

export type SetupSection = "anthropic" | "github" | "slack";

/** A domain error plus the wizard field it belongs to: `token`, `confirm` or `<section>.<field>`. */
export type SetupError = DomainError & { field?: string };

type AnthropicInput = { apiKey?: string; authToken?: string; baseUrl?: string; model?: string };
type GithubInput = { token: string; repos: string[] };
type SlackInput = { userToken: string; signingSecret?: string };

export type FinishSetupInput = {
  token: string;
  confirm: string;
  /** An omitted section is not written; rows stored earlier stay as they are. */
  anthropic?: AnthropicInput;
  github?: GithubInput;
  slack?: SlackInput;
};

export type SetupSections = Record<SetupSection, boolean>;

/**
 * Every anonymous setup call (checks and the final submit) counts here, per client IP, in its own
 * namespace: it never touches the login counter.
 */
export const SETUP_ATTEMPT_POLICY: AttemptPolicy = {
  limit: 30,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
};

export function setupAttemptKey(ip: string | undefined): string {
  return `setup:${ip || "unknown"}`;
}

/** `conflict` once initialized, else `rate_limited` over the per-IP limit, else null. */
async function gate(deps: SetupDeps, ip: string | undefined): Promise<DomainError | null> {
  if (await deps.loginTokens.isInitialized()) return ALREADY_INITIALIZED;
  const attempt = await deps.attemptLimiter.attempt(setupAttemptKey(ip), SETUP_ATTEMPT_POLICY);
  if (attempt.allowed) return null;
  deps.logger.warn("setup rate limited", { ip, retryAfterMs: attempt.retryAfterMs });
  return { kind: "rate_limited", retryAfterMs: attempt.retryAfterMs };
}

/** Moves an error onto its section: `field` becomes `<section>.<field>`, or the section itself. */
function inSection(section: SetupSection, error: SetupError, field?: string): SetupError {
  const own = field ?? error.field;
  return { ...error, field: own ? `${section}.${own}` : section };
}

// ---- Per-section validation (format, then the provider's check) ----

async function prepareAnthropicSection(
  deps: SetupDeps,
  input: AnthropicInput,
): Promise<Result<PreparedAnthropic, SetupError>> {
  const prepared = await prepareAnthropic(deps, input);
  return prepared.ok ? prepared : err(inSection("anthropic", prepared.error));
}

const GITHUB_REJECTED: DomainError = { kind: "forbidden", reason: "Token rejected by GitHub." };

async function verifyGithubToken(
  deps: SetupDeps,
  input: unknown,
): Promise<Result<{ token: string; user: VerifiedToken }, SetupError>> {
  const parsed = parseTokenInput(input);
  if (!parsed.ok) return err(inSection("github", parsed.error));
  const verified = await deps.githubVerifier.verifyToken(parsed.value);
  if (verified.ok) return ok({ token: parsed.value, user: verified.value });
  return verified.error.kind === "forbidden"
    ? err(inSection("github", GITHUB_REJECTED, "token"))
    : err(inSection("github", verified.error));
}

type PreparedGithub = { token: string; user: VerifiedToken; repos: RepoCheckResult[] };

const repoError = (error: DomainError) => err(inSection("github", error, "repos"));

async function prepareGithubSection(
  deps: SetupDeps,
  input: GithubInput,
): Promise<Result<PreparedGithub, SetupError>> {
  const verified = await verifyGithubToken(deps, input.token);
  if (!verified.ok) return verified;
  const { token, user } = verified.value;

  // Repos already in the list stay; duplicates in the selection count once.
  const seen = new Set((await deps.githubRepos.listRepos()).map((r) => repoKey(r.canonical)));
  const stored = seen.size;
  const entries = [];
  for (const raw of input.repos) {
    const parsed = parseRepoEntry(raw);
    if (!parsed.ok) return repoError(parsed.error);
    const key = repoKey(parsed.value.canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(parsed.value);
  }
  if (stored + entries.length > MAX_REPOS) {
    return repoError({
      kind: "validation",
      field: "repos",
      message: `Select at most ${MAX_REPOS} repositories.`,
    });
  }

  const info = { tokenKind: user.tokenKind, scopes: user.scopes };
  const repos: RepoCheckResult[] = [];
  for (const entry of entries) {
    const checked = await deps.githubVerifier.checkRepo(
      token,
      { owner: entry.owner, repo: entry.repo },
      info,
    );
    if (checked.ok) repos.push(checked.value);
    else if (checked.error.kind === "not_found" || checked.error.kind === "forbidden") {
      // The name passed the format check, so it is safe to show.
      return repoError({
        kind: "forbidden",
        reason: `The token cannot access ${entry.canonical}.`,
      });
    } else return err(inSection("github", checked.error));
  }
  return ok({ token, user, repos });
}

type CheckedSecret = { value: string; checked: CheckedSlackSecret };
type PreparedSlack = Partial<Record<SlackSecretKind, CheckedSecret>>;

async function checkSlack(
  deps: SetupDeps,
  kind: SlackSecretKind,
  input: unknown,
): Promise<Result<CheckedSecret, SetupError>> {
  const parsed = parseSlackSecret(kind, input);
  if (!parsed.ok) return err(inSection("slack", parsed.error));
  const checked = await checkSlackSecret(deps, kind, parsed.value);
  if (checked.ok) return ok({ value: parsed.value, checked: checked.value });
  const field = checked.error.kind === "forbidden" ? "userToken" : undefined;
  return err(inSection("slack", checked.error, field));
}

async function prepareSlackSection(
  deps: SetupDeps,
  input: SlackInput,
): Promise<Result<PreparedSlack, SetupError>> {
  // Format first, so a malformed signing secret fails before any Slack call.
  if (input.signingSecret) {
    const parsed = parseSlackSecret("slack_signing_secret", input.signingSecret);
    if (!parsed.ok) return err(inSection("slack", parsed.error));
  }
  const user = await checkSlack(deps, "slack_user_token", input.userToken);
  if (!user.ok) return user;
  const prepared: PreparedSlack = { slack_user_token: user.value };
  if (input.signingSecret) {
    const signing = await checkSlack(deps, "slack_signing_secret", input.signingSecret);
    if (!signing.ok) return signing;
    prepared.slack_signing_secret = signing.value;
  }
  return ok(prepared);
}

type Plan = {
  token: string;
  anthropic: PreparedAnthropic | null;
  github: PreparedGithub | null;
  slack: PreparedSlack | null;
};

async function prepare(
  deps: SetupDeps,
  input: FinishSetupInput,
): Promise<Result<Plan, SetupError>> {
  const token = validateLoginTokenInput(input.token);
  if (!token.ok) return token;
  if (input.confirm !== token.value) {
    return err({ kind: "validation", field: "confirm", message: "Tokens do not match." });
  }
  const plan: Plan = { token: token.value, anthropic: null, github: null, slack: null };
  if (input.anthropic) {
    const prepared = await prepareAnthropicSection(deps, input.anthropic);
    if (!prepared.ok) return prepared;
    plan.anthropic = prepared.value;
  }
  if (input.github) {
    const prepared = await prepareGithubSection(deps, input.github);
    if (!prepared.ok) return prepared;
    plan.github = prepared.value;
  }
  if (input.slack) {
    const prepared = await prepareSlackSection(deps, input.slack);
    if (!prepared.ok) return prepared;
    plan.slack = prepared.value;
  }
  return ok(plan);
}

const sectionsOf = (plan: Plan): SetupSection[] =>
  (["anthropic", "github", "slack"] as const).filter((s) => plan[s] !== null);

/**
 * Validates everything (409 when initialized, before any hashing or provider call), then writes
 * in ONE transaction: the login token first (concurrent setups serialise on it; the loser rolls
 * back as `conflict`), the owner user, and each provided section with its history event as that
 * user. Any failure rolls back all of it. Then signs the owner in.
 */
export async function finishSetup(
  deps: SetupDeps,
  input: FinishSetupInput,
  ip: string | undefined,
  headers: Headers,
): Promise<Result<void, SetupError>> {
  const refused = await gate(deps, ip);
  if (refused) return err(refused);
  const prepared = await prepare(deps, input);
  if (!prepared.ok) return prepared;
  const plan = prepared.value;
  const hash = await deps.loginTokenHasher.hash(plan.token);

  const written = await deps.setupUnitOfWork.run(async (tx): Promise<Result<void>> => {
    const stored = await tx.initializeLoginToken(hash);
    if (!stored.ok) return stored;
    const userId = await tx.ensureOwnerUser();
    const now = deps.clock.now();
    const at = { ...deps, clock: { now: () => now } };
    if (plan.anthropic) {
      await writeAnthropicSettings(
        { ids: deps.ids, settingsStore: tx.settingsStore },
        { userId },
        plan.anthropic,
        now,
      );
    }
    if (plan.github) {
      const { token, user, repos } = plan.github;
      await storeGithubToken(
        { ...at, githubCredentials: tx.githubCredentials },
        userId,
        token,
        user,
      );
      for (const repo of repos) {
        const added = await storeRepo({ ...at, githubRepos: tx.githubRepos }, userId, repo);
        if (!added.ok) return added;
      }
    }
    for (const [kind, secret] of Object.entries(plan.slack ?? {}) as [
      SlackSecretKind,
      CheckedSecret,
    ][]) {
      await storeSlackSecret(
        { ...at, settingsStore: tx.settingsStore },
        userId,
        kind,
        secret.value,
        secret.checked,
      );
    }
    return ok(undefined);
  });
  if (!written.ok) return written;

  if (plan.slack) await publishSlackSettingsChanged(deps);
  deps.logger.info("setup finished", { sections: sectionsOf(plan).join(",") || "none" });
  await deps.auth.signInOwner(headers);
  return ok(undefined);
}

// ---- Setup-only checks: anonymous, read-only, conflict once initialized ----

const stored = (...reads: { state: string }[]) => reads.some((r) => r.state !== "not_configured");

/** Which sections already have stored values, for the wizard's 已配置. Booleans only. */
export async function getSetupSections(
  deps: SetupDeps,
  ip: string | undefined,
): Promise<Result<SetupSections>> {
  const refused = await gate(deps, ip);
  if (refused) return err(refused);
  const store = deps.settingsStore;
  const [apiKey, authToken, slackUser, slackSigning, github] = await Promise.all([
    store.getSecret("anthropic_api_key"),
    store.getSecret("anthropic_auth_token"),
    store.getSecret("slack_user_token"),
    store.getSecret("slack_signing_secret"),
    deps.githubCredentials.get(),
  ]);
  return ok({
    anthropic: stored(apiKey, authToken),
    github: github !== null,
    slack: stored(slackUser, slackSigning),
  });
}

/** Probes Anthropic with the given values and the probe model. Stores nothing. */
export async function testSetupAnthropic(
  deps: SetupDeps,
  input: AnthropicInput,
  ip: string | undefined,
): Promise<Result<LlmProbeView, SetupError>> {
  const refused = await gate(deps, ip);
  if (refused) return err(refused);
  const prepared = await prepareAnthropicSection(deps, input);
  if (!prepared.ok) return prepared;
  const probe = await probeAnthropic(deps, prepared.value);
  return probe.ok ? probe : err(inSection("anthropic", probe.error));
}

export type SetupGithubRepos = {
  login: string;
  repos: AccessibleRepoOption[];
  truncated: boolean;
};

/** Verifies the given GitHub token and lists the repos it can access. Stores nothing. */
export async function listSetupGithubRepos(
  deps: SetupDeps,
  input: { token: string },
  ip: string | undefined,
): Promise<Result<SetupGithubRepos, SetupError>> {
  const refused = await gate(deps, ip);
  if (refused) return err(refused);
  const verified = await verifyGithubToken(deps, input.token);
  if (!verified.ok) return verified;
  const listed = await deps.githubClient(verified.value.token).listAccessibleRepos();
  if (!listed.ok) return err(inSection("github", listed.error));
  return ok({
    login: verified.value.user.login,
    repos: listed.value.repos
      .filter((r) => !r.archived)
      .map((r) => ({ fullName: r.fullName, private: r.private, canPush: r.canPush })),
    truncated: listed.value.truncated,
  });
}

/** Checks the Slack user token (auth.test). Stores nothing. */
export async function testSetupSlack(
  deps: SetupDeps,
  input: { userToken: string },
  ip: string | undefined,
): Promise<Result<{ teamName: string }, SetupError>> {
  const refused = await gate(deps, ip);
  if (refused) return err(refused);
  const checked = await checkSlack(deps, "slack_user_token", input.userToken);
  if (!checked.ok) return checked;
  const teamName = checked.value.checked.testResult?.teamName;
  return ok({ teamName: typeof teamName === "string" ? teamName : "" });
}
