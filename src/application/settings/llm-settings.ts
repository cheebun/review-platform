import {
  classifyProbe,
  ANTHROPIC_PROBE_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  parseAnthropicSettings,
  selectLlmProvider,
  toLlmCredentialView,
  type AnthropicCredentialType,
  type AnthropicTarget,
  type LlmCredentialView,
  type LlmProbeOutcome,
} from "../../domain/settings/llm-settings";
import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { EventDetail, NewReviewEvent } from "../../ports/review-event-repo";
import {
  bundleChanged,
  type SecretKind,
  type SecretRead,
  type SecretWrite,
  type SettingKey,
  type SettingsBundle,
  type SettingsBundleOutcome,
  type SettingValues,
} from "../../ports/settings-store";
import type { LlmSettingsDeps } from "./llm-deps";
import { FORBIDDEN_NON_USER } from "./view";

/** Saves and connection tests have independent per-user budgets. */
export const LLM_SAVE_LIMIT = { limit: 10, windowMs: 600_000 } as const;

export const LLM_TEST_LIMIT = LLM_SAVE_LIMIT;

type Section = "anthropic";

const ANTHROPIC_VALUE_KEYS = [
  "anthropic_base_url",
  "anthropic_model",
] as const satisfies readonly SettingKey[];
const CREDENTIAL_KIND: Record<AnthropicCredentialType, SecretKind> = {
  api_key: "anthropic_api_key",
  auth_token: "anthropic_auth_token",
};

const REJECTED: DomainError = {
  kind: "forbidden",
  reason: "The LLM provider rejected the credentials.",
};
const UNREACHABLE: DomainError = { kind: "upstream", service: "llm", retryable: true };

export type LlmAvailability = "ready" | "not_configured" | "needs_reset";

/** The LLM section of `/settings`. Never contains a secret value. */
export type LlmSettingsView = {
  availability: LlmAvailability;
  /** The provider the review uses now. */
  active: "anthropic" | null;
  anthropic: {
    credentialType: AnthropicCredentialType | null;
    credential: LlmCredentialView;
    /** Stored values; null means the default. */
    baseUrl: string | null;
    model: string | null;
    defaultModel: string;
  };
};

/** The probe as the page shows it: status, model and latency, never the key. */
export type LlmProbeView = { verdict: "verified"; model: string; latencyMs: number };

/** A successful test; `view` is the refreshed section when it marked the saved credential verified. */
export type LlmTestResult = LlmProbeView & { view: LlmSettingsView | null };

export type LlmSaveResult = { view: LlmSettingsView };

const chosenAnthropic = (
  apiKey: SecretRead,
  authToken: SecretRead,
): { type: AnthropicCredentialType; read: SecretRead } | null => {
  if (authToken.state !== "not_configured") return { type: "auth_token", read: authToken };
  if (apiKey.state !== "not_configured") return { type: "api_key", read: apiKey };
  return null;
};

async function buildView(deps: LlmSettingsDeps): Promise<LlmSettingsView> {
  const store = deps.settingsStore;
  const [apiKey, authToken, values] = await Promise.all([
    store.getSecret("anthropic_api_key"),
    store.getSecret("anthropic_auth_token"),
    store.getValues(ANTHROPIC_VALUE_KEYS),
  ]);
  const selected = selectLlmProvider({
    anthropic_api_key: apiKey.state,
    anthropic_auth_token: authToken.state,
  });
  const anthropic = chosenAnthropic(apiKey, authToken);
  const baseUrl = values.anthropic_base_url ?? null;
  return {
    availability: selected.provider ? "ready" : selected.reason,
    active: selected.provider,
    anthropic: {
      credentialType: anthropic?.type ?? null,
      credential: anthropic ? toLlmCredentialView(anthropic.read) : { state: "unset" },
      baseUrl,
      model: values.anthropic_model ?? null,
      defaultModel: DEFAULT_ANTHROPIC_MODEL,
    },
  };
}

export async function getLlmSettingsView(
  deps: LlmSettingsDeps,
  actor: Actor,
): Promise<Result<LlmSettingsView>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  return ok(await buildView(deps));
}

type UserActor = Extract<Actor, { kind: "user" }>;

async function limited(
  deps: LlmSettingsDeps,
  actor: UserActor,
  action: "save" | "test",
): Promise<DomainError | null> {
  const limit = await deps.rateLimiter.hit(
    `llm-settings:${action}:${actor.userId}`,
    action === "test" ? LLM_TEST_LIMIT : LLM_SAVE_LIMIT,
  );
  return limit.allowed ? null : { kind: "rate_limited", retryAfterMs: limit.retryAfterMs };
}

/** Maps a connection test to a safe, structured response. */
function judge(
  outcome: LlmProbeOutcome,
  credentialField: string,
): Result<LlmProbeView, DomainError & { field?: string }> {
  switch (classifyProbe(outcome)) {
    case "verified":
      return outcome.kind === "ok"
        ? ok({
            verdict: "verified",
            model: outcome.model,
            latencyMs: Math.round(outcome.latencyMs),
          })
        : err(UNREACHABLE);
    case "rejected":
      return err({ ...REJECTED, field: credentialField });
    case "refused":
      return err({
        kind: "validation",
        field: "baseUrl",
        message: `The endpoint refused the test request (HTTP ${outcome.kind === "error" ? (outcome.status ?? 0) : 0}). Check the base URL and the model.`,
      });
    case "unreachable":
      return err(UNREACHABLE);
  }
}

type Writer = {
  deps: Pick<LlmSettingsDeps, "ids" | "settingsStore">;
  actor: Pick<UserActor, "userId">;
  section: Section;
  now: Date;
};

/** Given values are saved, null (or absent) ones removed, so their default applies. */
function splitValues(
  keys: readonly SettingKey[],
  values: Partial<Record<SettingKey, string | boolean | null>>,
): Pick<SettingsBundle, "values" | "removeValues"> {
  const save: Partial<Record<SettingKey, string | boolean>> = {};
  const remove: SettingKey[] = [];
  for (const key of keys) {
    const v = values[key];
    if (v === null || v === undefined) remove.push(key);
    else save[key] = v;
  }
  return { values: save as Partial<SettingValues>, removeValues: remove };
}

const savedKeys = (o: SettingsBundleOutcome) =>
  [...o.savedSecrets.map((x) => x.kind), ...o.changedValues].join(",");
const removedKeys = (o: SettingsBundleOutcome) =>
  [...o.removedSecrets.map((x) => x.kind), ...o.removedValues].join(",");

/**
 * Writes one bundle: every secret and value of the section with ONE history event, in ONE store
 * transaction (a failed event changes nothing). The event names the keys and the saved
 * credential's last 4 characters, never a value. Nothing changed records no event.
 */
async function writeBundle(w: Writer, bundle: SettingsBundle): Promise<SettingsBundleOutcome> {
  const eventId = w.deps.ids.uuid();
  return w.deps.settingsStore.saveBundle(bundle, {
    at: w.now,
    by: w.actor.userId,
    event: (o): NewReviewEvent => {
      const saved = savedKeys(o);
      const removed = removedKeys(o);
      const secret = o.savedSecrets[0];
      const detail: EventDetail = { section: w.section };
      if (saved) detail.keys = saved;
      if (removed) detail[saved ? "removed" : "keys"] = removed;
      if (secret) {
        detail.last4 = secret.meta.last4;
        detail.replaced = secret.replaced;
      }
      return {
        id: eventId,
        type: saved ? "settings_value_saved" : "settings_value_removed",
        actor: { kind: "user", id: w.actor.userId },
        at: w.now,
        source: "web",
        detail,
      };
    },
  });
}

const unverifiedSecret = (w: Writer, value: string): SecretWrite => ({
  value,
  savedAt: w.now,
  savedByUserId: w.actor.userId,
  verifiedAt: null,
  testResult: null,
});

const credentialMissing = (field: string, stored: SecretRead | null): DomainError => ({
  kind: "validation",
  field,
  message:
    stored?.state === "needs_reset"
      ? "The stored credential cannot be read any more; enter it again."
      : "An API key or an auth token is required.",
});

/** Validates both actions and resolves an unchanged, masked credential server-side. */
export async function prepareAnthropic(
  deps: Pick<LlmSettingsDeps, "settingsStore">,
  input: Parameters<typeof parseAnthropicSettings>[0],
) {
  const parsed = parseAnthropicSettings(input);
  if (!parsed.ok) return parsed;
  const settings = parsed.value;

  let credential = settings.credential;
  if (!credential) {
    const [apiKey, authToken] = await Promise.all([
      deps.settingsStore.getSecret("anthropic_api_key"),
      deps.settingsStore.getSecret("anthropic_auth_token"),
    ]);
    const stored = chosenAnthropic(apiKey, authToken);
    if (!stored || stored.read.state !== "ready") {
      return err(credentialMissing("credential", stored?.read ?? null));
    }
    credential = { kind: stored.type, value: stored.read.value };
  }

  return ok({ settings, credential });
}

/** Persists one encrypted bundle without making a provider request. */
export async function saveAnthropicSettings(
  deps: LlmSettingsDeps,
  actor: Actor,
  input: Parameters<typeof parseAnthropicSettings>[0],
): Promise<Result<LlmSaveResult>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  const limit = await limited(deps, actor, "save");
  if (limit) return err(limit);
  const prepared = await prepareAnthropic(deps, input);
  if (!prepared.ok) return prepared;
  await writeAnthropicSettings(deps, actor, prepared.value, deps.clock.now());
  const credential = prepared.value.credential.kind;
  deps.logger.info("llm settings saved", { section: "anthropic", credential });
  return ok({ view: await buildView(deps) });
}

export type PreparedAnthropic = Extract<
  Awaited<ReturnType<typeof prepareAnthropic>>,
  { ok: true }
>["value"];

/**
 * Stores prepared Anthropic settings as one bundle: the values, the credential (unverified) and
 * the removal of the other credential type. `deps.settingsStore` may be bound to an outer
 * transaction (first-run setup).
 */
export async function writeAnthropicSettings(
  deps: Pick<LlmSettingsDeps, "ids" | "settingsStore">,
  actor: Pick<UserActor, "userId">,
  { settings, credential }: PreparedAnthropic,
  now: Date,
): Promise<void> {
  const w: Writer = { deps, actor, section: "anthropic", now };
  const other = credential.kind === "api_key" ? "auth_token" : "api_key";
  await writeBundle(w, {
    ...splitValues(ANTHROPIC_VALUE_KEYS, {
      anthropic_base_url: settings.baseUrl,
      anthropic_model: settings.model,
    }),
    secrets: {
      [CREDENTIAL_KIND[credential.kind]]: unverifiedSecret(w, credential.value),
    },
    removeSecrets: [CREDENTIAL_KIND[other]],
  });
}

/** One `llm:ping` with the probe model, judged; never the configured review model. */
export async function probeAnthropic(
  deps: Pick<LlmSettingsDeps, "llmProbe">,
  { settings, credential }: PreparedAnthropic,
): Promise<Result<LlmProbeView, DomainError & { field?: string }>> {
  const target: AnthropicTarget = {
    provider: "anthropic",
    baseUrl: settings.baseUrl,
    model: ANTHROPIC_PROBE_MODEL,
    credential,
  };
  return judge(await deps.llmProbe(target), credential.kind === "api_key" ? "apiKey" : "authToken");
}

/**
 * The version of the saved credential when the tested settings are exactly the saved ones (base
 * URL, model, credential type and value); null for an unsaved draft.
 */
async function savedVersionOf(
  deps: LlmSettingsDeps,
  { settings, credential }: PreparedAnthropic,
): Promise<number | null> {
  const store = deps.settingsStore;
  const [apiKey, authToken, values] = await Promise.all([
    store.getSecret("anthropic_api_key"),
    store.getSecret("anthropic_auth_token"),
    store.getValues(ANTHROPIC_VALUE_KEYS),
  ]);
  const saved = chosenAnthropic(apiKey, authToken);
  if (saved?.read.state !== "ready") return null;
  const same =
    saved.type === credential.kind &&
    saved.read.value === credential.value &&
    (values.anthropic_base_url ?? null) === settings.baseUrl &&
    (values.anthropic_model ?? null) === settings.model;
  return same ? saved.read.meta.version : null;
}

/**
 * Marks the saved credential verified (⚠ 未验证 → verified) for the version that was tested; a
 * credential saved since keeps its own state. A store failure is logged and records nothing.
 */
async function markVerified(
  deps: LlmSettingsDeps,
  credential: PreparedAnthropic["credential"],
  version: number,
): Promise<boolean> {
  try {
    return await deps.settingsStore.markSecretVerified(
      CREDENTIAL_KIND[credential.kind],
      version,
      deps.clock.now(),
    );
  } catch (error) {
    deps.logger.warn("llm credential not marked verified", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

/**
 * Tests current form values without saving them or writing history. A successful test of exactly
 * the saved settings marks the saved credential verified and returns the refreshed view; a draft
 * or a failed test writes nothing, so an earlier verification stays.
 */
export async function testAnthropicSettings(
  deps: LlmSettingsDeps,
  actor: Actor,
  input: Parameters<typeof parseAnthropicSettings>[0],
): Promise<Result<LlmTestResult>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  const limit = await limited(deps, actor, "test");
  if (limit) return err(limit);
  const prepared = await prepareAnthropic(deps, input);
  if (!prepared.ok) return prepared;
  const probe = await probeAnthropic(deps, prepared.value);
  if (!probe.ok) return probe;
  const version = await savedVersionOf(deps, prepared.value);
  const marked = version !== null && (await markVerified(deps, prepared.value.credential, version));
  return ok({ ...probe.value, view: marked ? await buildView(deps) : null });
}

async function removeSection(
  deps: LlmSettingsDeps,
  actor: Actor,
  section: Section,
): Promise<Result<LlmSettingsView>> {
  if (actor.kind !== "user") return err(FORBIDDEN_NON_USER);
  const w: Writer = { deps, actor, section, now: deps.clock.now() };
  const kinds: SecretKind[] = ["anthropic_api_key", "anthropic_auth_token"];
  const outcome = await writeBundle(w, {
    removeSecrets: kinds,
    removeValues: ANTHROPIC_VALUE_KEYS,
  });
  if (bundleChanged(outcome)) deps.logger.info("llm settings removed", { section });
  return ok(await buildView(deps));
}

/** Removes the Anthropic credential and values. */
export const removeAnthropicSettings = (deps: LlmSettingsDeps, actor: Actor) =>
  removeSection(deps, actor, "anthropic");
