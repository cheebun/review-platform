import { err, ok, type Result } from "../shared/result";

/**
 * Crypto primitives are injected because `domain` may not import `node:crypto`. The window,
 * format and length rules live here (pure, table-testable); the adapter supplies HMAC-SHA256
 * and a constant-time compare (src/adapters/slack/signature.ts).
 */
export type SlackCrypto = {
  hmacSha256Hex(secret: string, data: string): string;
  /** Constant-time. Only called with equal-length strings. */
  timingSafeEqual(a: string, b: string): boolean;
};

export type VerifySlackSignatureInput = {
  secret: string;
  rawBody: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  now: Date;
  crypto: SlackCrypto;
};

export const SLACK_SIGNATURE_MAX_SKEW_S = 300;

const rejected = () => err({ kind: "unauthenticated" as const });

/** https://docs.slack.dev/authentication/verifying-requests-from-slack/ */
export function verifySlackSignature(input: VerifySlackSignatureInput): Result<void> {
  const { secret, rawBody, timestamp, signature, now, crypto } = input;
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return rejected();
  // Reject replays of captured requests (and timestamps from the future).
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SLACK_SIGNATURE_MAX_SKEW_S)
    return rejected();
  const expected = `v0=${crypto.hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;
  if (signature.length !== expected.length) return rejected();
  return crypto.timingSafeEqual(expected, signature) ? ok(undefined) : rejected();
}
