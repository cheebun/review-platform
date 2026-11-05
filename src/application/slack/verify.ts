/**
 * FR-SLACK-01: Slack request signatures, checked on the raw body against the stored signing
 * secret. The window (5 min), format and constant-time compare are the domain's
 * (`verifySlackSignature`). The first request that verifies marks the stored secret verified
 * (⚠ 未验证 → verified) once per version.
 */
import { ok, type Result } from "../../domain/shared/result";
import { verifySlackSignature, type SlackCrypto } from "../../domain/slack/signature";
import type { SettingsStore } from "../../ports/settings-store";
import type { Clock, Logger } from "../../ports/system";
import type { SlackCredentials, SlackSecret } from "./credentials";

export type SlackVerifyDeps = {
  credentials: SlackCredentials;
  settingsStore: Pick<SettingsStore, "markSecretVerified">;
  crypto: SlackCrypto;
  clock: Clock;
  logger: Logger;
};

export type SignedRequest = {
  rawBody: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
};

function check(deps: SlackVerifyDeps, secret: SlackSecret, req: SignedRequest): Result<void> {
  return verifySlackSignature({
    secret: secret.value,
    rawBody: req.rawBody,
    timestamp: req.timestamp,
    signature: req.signature,
    now: deps.clock.now(),
    crypto: deps.crypto,
  });
}

async function markVerified(deps: SlackVerifyDeps, secret: SlackSecret): Promise<void> {
  if (secret.verified) return;
  // Marked in the cache first, so concurrent requests do not all write.
  deps.credentials.markVerified("slack_signing_secret", secret.version);
  try {
    await deps.settingsStore.markSecretVerified(
      "slack_signing_secret",
      secret.version,
      deps.clock.now(),
    );
  } catch (error) {
    deps.logger.warn("signing secret not marked verified", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * `not_configured` (feature `slack_events`, with `needs_reset` when the row cannot be
 * decrypted) or `unauthenticated`. A store failure rejects (the caller answers 500, Slack
 * retries). On a mismatch the secret is re-read once past the cache, so a secret saved within
 * the cache TTL is used at once.
 */
export async function verifySlackRequest(
  deps: SlackVerifyDeps,
  req: SignedRequest,
): Promise<Result<void>> {
  const secret = await deps.credentials.signingSecret();
  if (!secret.ok) return secret;
  let verdict = check(deps, secret.value, req);
  let used = secret.value;
  if (!verdict.ok && (await deps.credentials.refresh("slack_signing_secret"))) {
    const fresh = await deps.credentials.signingSecret();
    if (!fresh.ok) return fresh;
    used = fresh.value;
    verdict = check(deps, used, req);
  }
  if (!verdict.ok) return verdict;
  await markVerified(deps, used);
  return ok(undefined);
}
