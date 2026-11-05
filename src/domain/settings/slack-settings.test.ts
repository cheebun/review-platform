import { describe, expect, it } from "vitest";
import {
  filterChannels,
  MAX_REVIEW_CHANNELS,
  parseReviewChannelIds,
  parseSlackSecret,
  slackAvailability,
  toSlackSecretView,
} from "./slack-settings";

// Obviously fake values, never real credentials.
const USER_TOKEN = "xoxp-0000-FAKE-user-token-SENTINEL-9f3c";
const SIGNING = "0123456789abcdef0123456789ab77aa";

describe("parseSlackSecret", () => {
  it("accepts each kind's format and trims a pasted newline", () => {
    expect(parseSlackSecret("slack_user_token", ` ${USER_TOKEN}\n`)).toEqual({
      ok: true,
      value: USER_TOKEN,
    });
    expect(parseSlackSecret("slack_user_token", "xoxe.xoxp-1-FAKEROTATEDTOKEN0000")).toEqual({
      ok: true,
      value: "xoxe.xoxp-1-FAKEROTATEDTOKEN0000",
    });
    expect(parseSlackSecret("slack_signing_secret", SIGNING.toUpperCase())).toEqual({
      ok: true,
      value: SIGNING.toUpperCase(),
    });
  });

  it.each([
    ["slack_user_token", "userToken", "xoxb-0000-FAKE-bot-token-SENTINEL"],
    ["slack_user_token", "userToken", "xapp-1-AFAKE-0000-app-token-SENTINEL"],
    ["slack_user_token", "userToken", "xoxp-short"],
    ["slack_user_token", "userToken", `xoxp-${"a".repeat(600)}`],
    ["slack_user_token", "userToken", "xoxp-0000-FAKE user-token-SENTINEL"],
    ["slack_user_token", "userToken", ""],
    ["slack_signing_secret", "signingSecret", "not-hex-not-hex-not-hex"],
    ["slack_signing_secret", "signingSecret", "abc123"],
    ["slack_signing_secret", "signingSecret", "   "],
  ] as const)("%s rejects a bad value on field %s", (kind, field, value) => {
    const r = parseSlackSecret(kind, value);
    expect(r).toMatchObject({ ok: false, error: { kind: "validation", field } });
    expect(JSON.stringify(r)).not.toContain(value.trim() || "\u0000");
  });

  it("rejects a non-string", () => {
    expect(parseSlackSecret("slack_user_token", 42)).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "userToken" },
    });
  });
});

describe("parseReviewChannelIds", () => {
  it("keeps valid ids in order, without duplicates", () => {
    expect(parseReviewChannelIds(["C0AAA", "G0BBB", "C0AAA"])).toEqual({
      ok: true,
      value: ["C0AAA", "G0BBB"],
    });
    expect(parseReviewChannelIds([])).toEqual({ ok: true, value: [] });
  });

  it.each([
    ["not an array", "C0AAA"],
    ["a DM id", ["D0AAA"]],
    ["lower case", ["c0aaa"]],
    ["a non-string", [1]],
    ["too many", Array.from({ length: MAX_REVIEW_CHANNELS + 1 }, (_, i) => `C${1000 + i}`)],
  ])("rejects %s", (_name, input) => {
    expect(parseReviewChannelIds(input)).toMatchObject({
      ok: false,
      error: { kind: "validation", field: "channels" },
    });
  });
});

describe("slackAvailability (FR-SLACKCFG-02)", () => {
  it("no user token → not_configured", () => {
    expect(
      slackAvailability({
        slack_user_token: "not_configured",
        slack_signing_secret: "ready",
      }),
    ).toBe("not_configured");
  });

  it("any undecryptable secret → needs_reset, even without a user token", () => {
    expect(
      slackAvailability({
        slack_user_token: "not_configured",
        slack_signing_secret: "needs_reset",
      }),
    ).toBe("needs_reset");
  });

  it("a decryptable user token → ready", () => {
    expect(
      slackAvailability({
        slack_user_token: "ready",
        slack_signing_secret: "not_configured",
      }),
    ).toBe("ready");
  });
});

describe("toSlackSecretView", () => {
  const meta = {
    kind: "slack_user_token" as const,
    last4: "9f3c",
    savedAt: new Date("2026-11-04T03:00:00.000Z"),
    savedByUserId: "u1",
    verifiedAt: new Date("2026-11-04T03:00:01.000Z"),
    testResult: { teamName: "Acme", userName: "owner", userId: "U1", teamId: "T1" },
    version: 3,
  };

  it("unset", () => {
    expect(toSlackSecretView({ state: "not_configured" })).toEqual({ state: "unset" });
  });

  it("picks only display fields: never the value, ids or the saver", () => {
    // A full `SecretRead` (with the value) as the store returns it; the view must drop the value.
    const read = { state: "ready" as const, value: USER_TOKEN, meta };
    const view = toSlackSecretView(read);
    expect(view).toEqual({
      state: "set",
      last4: "9f3c",
      savedAt: "2026-11-04T03:00:00.000Z",
      verifiedAt: "2026-11-04T03:00:01.000Z",
      teamName: "Acme",
      userName: "owner",
    });
    expect(JSON.stringify(view)).not.toContain(USER_TOKEN);
  });

  it("needs_reset keeps last 4 and the saved time; unverified has verifiedAt null", () => {
    const resetMeta = { ...meta, kind: "slack_app_token", verifiedAt: null, testResult: null };
    expect(toSlackSecretView({ state: "needs_reset", meta: resetMeta })).toEqual({
      state: "needs_reset",
      last4: "9f3c",
      savedAt: "2026-11-04T03:00:00.000Z",
      verifiedAt: null,
    });
  });
});

describe("filterChannels", () => {
  const list = [
    { id: "C1", name: "eng-review" },
    { id: "C2", name: "web-team" },
    { id: "C3", name: "Random" },
  ];

  it("matches a name substring, case-insensitively, ignoring a leading #", () => {
    expect(filterChannels(list, "REV").map((c) => c.id)).toEqual(["C1"]);
    expect(filterChannels(list, "#ran").map((c) => c.id)).toEqual(["C3"]);
    expect(filterChannels(list, "  ").map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
  });
});
