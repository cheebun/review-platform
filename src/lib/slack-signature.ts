import { createHmac, timingSafeEqual } from "node:crypto";

/** https://docs.slack.dev/authentication/verifying-requests-from-slack/ */
export function verifySlackSignature(input: {
  secret: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  now?: number;
}) {
  const { secret, body, timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  // Reject replays of captured requests.
  if (Math.abs((input.now ?? Date.now()) / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
