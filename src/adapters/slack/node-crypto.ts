import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SlackCrypto } from "../../domain/slack/signature";

/**
 * Real crypto for `verifySlackSignature`. The domain function owns the window, format and
 * length checks; this supplies HMAC-SHA256 and a constant-time compare.
 */
export const nodeSlackCrypto: SlackCrypto = {
  hmacSha256Hex: (secret, data) => createHmac("sha256", secret).update(data).digest("hex"),
  timingSafeEqual: (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  },
};

/** Stable message id (dedupe key) from `SlackReviewMessage.key`; same value as the legacy `id`. */
export const slackMessageId = (key: string): string =>
  createHash("sha256").update(key).digest("hex");
