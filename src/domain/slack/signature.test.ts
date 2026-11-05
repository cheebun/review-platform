import { describe, expect, it } from "vitest";
import { verifySlackSignature, type SlackCrypto } from "./signature";

// Deterministic stand-in: domain tests may not import node:crypto. The real HMAC is covered
// in src/adapters/slack/signature.test.ts.
const crypto: SlackCrypto = {
  hmacSha256Hex: (secret, data) =>
    `${secret.length}:${[...`${secret}|${data}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000_007, 7)}`.padEnd(
      64,
      "0",
    ),
  timingSafeEqual: (a, b) => a === b,
};

const secret = "fake-signing-secret";
const rawBody = "token=x&payload=%7B%7D";
const nowMs = 1_760_000_000_000;
const now = new Date(nowMs);
const sign = (ts: string, body = rawBody, s = secret) =>
  `v0=${crypto.hmacSha256Hex(s, `v0:${ts}:${body}`)}`;
const ts = String(nowMs / 1000);

const verify = (over: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({
    secret,
    rawBody,
    timestamp: ts,
    signature: sign(ts),
    now,
    crypto,
    ...over,
  });

describe("verifySlackSignature", () => {
  it("accepts a valid signature", () => {
    expect(verify()).toEqual({ ok: true, value: undefined });
  });

  it("rejects a tampered body", () => {
    expect(verify({ rawBody: `${rawBody} ` }).ok).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verify({ secret: "other" }).ok).toBe(false);
  });

  it("accepts exactly +-300 s of skew and rejects 301 s", () => {
    for (const delta of [-300, 300]) {
      const t = String(nowMs / 1000 + delta);
      expect(verify({ timestamp: t, signature: sign(t) }).ok).toBe(true);
    }
    for (const delta of [-301, 301]) {
      const t = String(nowMs / 1000 + delta);
      const r = verify({ timestamp: t, signature: sign(t) });
      expect(!r.ok && r.error.kind).toBe("unauthenticated");
    }
  });

  it("rejects a replayed old timestamp even with a correct signature", () => {
    const old = String(nowMs / 1000 - 3600);
    expect(verify({ timestamp: old, signature: sign(old) }).ok).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(verify({ timestamp: null }).ok).toBe(false);
    expect(verify({ signature: null }).ok).toBe(false);
    expect(verify({ timestamp: undefined }).ok).toBe(false);
    expect(verify({ signature: "" }).ok).toBe(false);
  });

  it("rejects v0= with the wrong length without calling the comparer", () => {
    let calls = 0;
    const counting: SlackCrypto = {
      ...crypto,
      timingSafeEqual: (a, b) => {
        calls++;
        return crypto.timingSafeEqual(a, b);
      },
    };
    expect(verify({ signature: "v0=short", crypto: counting }).ok).toBe(false);
    expect(calls).toBe(0);
  });

  it.each(["abc", "12.5", "-5", "1e9", " 1760000000", "0x10"])(
    "rejects non-numeric timestamp %j",
    (t) => {
      expect(verify({ timestamp: t, signature: sign(t) }).ok).toBe(false);
    },
  );
});
