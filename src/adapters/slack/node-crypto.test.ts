import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchSlackReviewMessage as legacyMatch } from "../../lib/slack-review-rules";
import { verifySlackSignature as legacyVerify } from "../../lib/slack-signature";
import { matchSlackReviewMessage } from "../../domain/slack/review-rules";
import { verifySlackSignature } from "../../domain/slack/signature";
import { nodeSlackCrypto, slackMessageId } from "./node-crypto";

const secret = "fake-signing-secret";
const body = "token=x&payload=%7B%7D";
const nowMs = 1_760_000_000_000;
const ts = String(nowMs / 1000);
const sign = (t: string, b = body, s = secret) =>
  `v0=${createHmac("sha256", s).update(`v0:${t}:${b}`).digest("hex")}`;
const verify = (over: Record<string, unknown> = {}) =>
  verifySlackSignature({
    secret,
    rawBody: body,
    timestamp: ts,
    signature: sign(ts),
    now: new Date(nowMs),
    crypto: nodeSlackCrypto,
    ...over,
  });

describe("verifySlackSignature with real HMAC-SHA256", () => {
  it("accepts a genuine Slack-style signature and rejects tampering", () => {
    expect(verify().ok).toBe(true);
    expect(verify({ rawBody: `${body} ` }).ok).toBe(false);
    expect(verify({ secret: "other" }).ok).toBe(false);
    expect(verify({ signature: "v0=short" }).ok).toBe(false);
    expect(verify({ signature: sign(ts).replace(/.$/, "0") }).ok).toBe(sign(ts).endsWith("0"));
  });

  it("agrees with the legacy verifier across skew, headers and tampering", () => {
    const cases: { t: string | null; sig: string | null; b: string; now: number }[] = [];
    for (const d of [-301, -300, -1, 0, 1, 300, 301, 3600]) {
      const t = String(nowMs / 1000 + d);
      cases.push({ t, sig: sign(t), b: body, now: nowMs });
      cases.push({ t, sig: sign(t), b: `${body}!`, now: nowMs });
    }
    cases.push({ t: null, sig: sign(ts), b: body, now: nowMs });
    cases.push({ t: ts, sig: null, b: body, now: nowMs });
    cases.push({ t: "abc", sig: "v0=x", b: body, now: nowMs });
    for (const c of cases) {
      expect(
        verifySlackSignature({
          secret,
          rawBody: c.b,
          timestamp: c.t,
          signature: c.sig,
          now: new Date(c.now),
          crypto: nodeSlackCrypto,
        }).ok,
      ).toBe(legacyVerify({ secret, body: c.b, timestamp: c.t, signature: c.sig, now: c.now }));
    }
  });
});

describe("slackMessageId", () => {
  it("equals the legacy sha256 message id for the dedupe key", () => {
    const payload = {
      type: "event_callback",
      team_id: "T_TEAM",
      authorizations: [{ user_id: "U_ME", is_bot: false }],
      event: {
        type: "message",
        user: "U_A",
        text: "<@U_ME> https://github.com/bosinc/katana-web/pull/1",
        channel: "C1",
        ts: "100.000001",
      },
    };
    const legacy = legacyMatch(payload, { userId: "U_ME", teamId: "T_TEAM" });
    const next = matchSlackReviewMessage(payload, {
      userId: "U_ME",
      teamId: "T_TEAM",
      repoList: ["bosinc/katana-web"],
    });
    expect(legacy).not.toBeNull();
    expect(slackMessageId(next!.key)).toBe(legacy!.id);
    expect(slackMessageId("a")).not.toBe(slackMessageId("b"));
  });
});
