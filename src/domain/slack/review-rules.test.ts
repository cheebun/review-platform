import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  extractReviewPrUrls as legacyExtract,
  matchSlackReviewMessage as legacyMatch,
  withinActiveHours as legacyHours,
} from "../../lib/slack-review-rules";
import {
  extractReviewPrUrls,
  matchSlackReviewMessage,
  withinActiveHours,
  type ReviewRuleOptions,
} from "./review-rules";

const url = "https://github.com/bosinc/katana-web/pull/17190";
const repoList = ["bosinc/katana-web", "Acme/Widget.js"];
const options: ReviewRuleOptions = {
  userId: "U_ME",
  teamId: "T_TEAM",
  repoList,
};
const message = (event: Record<string, unknown> = {}) => ({
  type: "event_callback",
  team_id: "T_TEAM",
  authorizations: [{ user_id: "U_ME", is_bot: false }],
  event: {
    type: "message",
    user: "U_YETIAN",
    text: `<@U_ME> ${url}`,
    channel: "C_CHANNEL",
    channel_type: "channel",
    ts: "100.000001",
    ...event,
  },
});

describe("extractReviewPrUrls(text, repoList) (FR-SLACK-03)", () => {
  it("accepts any repo in the list, not only bosinc/katana-web", () => {
    expect(extractReviewPrUrls("see https://github.com/Acme/Widget.js/pull/3", repoList)).toEqual([
      "https://github.com/Acme/Widget.js/pull/3",
    ]);
  });

  it("drops repos that are not in the list", () => {
    expect(
      extractReviewPrUrls(`https://github.com/other/repo/pull/2 ${url}`, ["other/elsewhere"]),
    ).toEqual([]);
    expect(extractReviewPrUrls("https://github.com/other/repo/pull/2", repoList)).toEqual([]);
  });

  it("matches nothing with an empty repo list", () => {
    expect(extractReviewPrUrls(url, [])).toEqual([]);
  });

  it("matches the repo case-insensitively and returns the list's canonical form", () => {
    expect(extractReviewPrUrls("HTTPS://GITHUB.COM/acme/WIDGET.JS/pull/3", repoList)).toEqual([
      "https://github.com/Acme/Widget.js/pull/3",
    ]);
  });

  it("does not treat a list entry as a prefix of a longer repo name", () => {
    expect(extractReviewPrUrls("https://github.com/acme/widget.jsx/pull/3", repoList)).toEqual([]);
    expect(extractReviewPrUrls("https://github.com/xacme/widget.js/pull/3", repoList)).toEqual([]);
  });

  it("unwraps Slack <url|label> and <url> and accepts the trailing tab forms", () => {
    for (const text of [
      `<${url}|PR 17190>`,
      `<${url}>`,
      `${url}/files`,
      `${url}/changes/`,
      `${url}/commits`,
      `<${url}/checks|checks>`,
      `(${url}).`,
    ])
      expect(extractReviewPrUrls(text, repoList), text).toEqual([url]);
  });

  it("rejects other suffixes and glued text", () => {
    for (const text of [`${url}suffix`, `${url}/files/abc`, `${url}/reviews`])
      expect(extractReviewPrUrls(text, repoList), text).toEqual([]);
  });

  it("requires a positive safe integer PR number", () => {
    for (const n of ["0", "01", "-1", "99999999999999999999", "9007199254740992"])
      expect(
        extractReviewPrUrls(`https://github.com/bosinc/katana-web/pull/${n}`, repoList),
        n,
      ).toEqual([]);
    expect(
      extractReviewPrUrls("https://github.com/bosinc/katana-web/pull/9007199254740991", repoList),
    ).toEqual(["https://github.com/bosinc/katana-web/pull/9007199254740991"]);
  });

  it("dedupes after normalisation, keeping first-seen order", () => {
    const other = "https://github.com/Acme/Widget.js/pull/9";
    expect(
      extractReviewPrUrls(
        `${other} <${url}|x> ${url}/files https://github.com/BOSINC/Katana-Web/pull/17190 ${other}`,
        repoList,
      ),
    ).toEqual([other, url]);
  });

  it("canonicalises the list entry even when the list itself has odd casing or spaces", () => {
    expect(extractReviewPrUrls(url, ["  bosinc/katana-web "])).toEqual([url]);
  });
});

describe("no sender allowlist (FR-SLACK-04)", () => {
  it("accepts any workspace member, in channels and DMs", () => {
    expect(matchSlackReviewMessage(message({ user: "U_STRANGER" }), options)?.sender).toBe(
      "U_STRANGER",
    );
    expect(
      matchSlackReviewMessage(message({ user: "U_STRANGER", channel_type: "im" }), options),
    ).not.toBeNull();
  });

  it("still requires a string sender", () => {
    expect(matchSlackReviewMessage(message({ user: undefined }), options)).toBeNull();
    expect(matchSlackReviewMessage(message({ user: 42 }), options)).toBeNull();
  });
});

describe("matchSlackReviewMessage rules", () => {
  it("returns the normalised message with a dedupe key", () => {
    expect(matchSlackReviewMessage(message({ thread_ts: "99.000001" }), options)).toEqual({
      key: "T_TEAM:C_CHANNEL:100.000001",
      channel: "C_CHANNEL",
      ts: "100.000001",
      threadTs: "99.000001",
      sender: "U_YETIAN",
      urls: [url],
    });
  });

  it("requires a mention, a PR url, no bot, no unsupported subtype", () => {
    for (const event of [
      { text: url },
      { text: "<@U_ME> hello" },
      { bot_id: "B_BOT" },
      { subtype: "message_changed" },
      { subtype: "message_deleted" },
      { subtype: "bot_message" },
      { hidden: true },
      { ts: "abc" },
      { type: "app_mention" },
    ])
      expect(matchSlackReviewMessage(message(event), options), JSON.stringify(event)).toBeNull();
    expect(matchSlackReviewMessage({ ...message(), team_id: "T_OTHER" }, options)).toBeNull();
    expect(matchSlackReviewMessage({ ...message(), type: "url_verification" }, options)).toBeNull();
    expect(matchSlackReviewMessage(null, options)).toBeNull();
  });

  it("accepts the file_share and thread_broadcast subtypes", () => {
    for (const subtype of ["file_share", "thread_broadcast"])
      expect(matchSlackReviewMessage(message({ subtype }), options)).not.toBeNull();
  });

  it("requires the authorization to be a non-bot user authorization", () => {
    expect(
      matchSlackReviewMessage(
        { ...message(), authorizations: [{ user_id: "U_ME", is_bot: true }] },
        options,
      ),
    ).toBeNull();
    expect(
      matchSlackReviewMessage(
        { ...message(), authorizations: [{ user_id: "U_OTHER", is_bot: false }] },
        options,
      ),
    ).toBeNull();
  });

  it("ignores links to repos outside the list, and everything with an empty list", () => {
    expect(
      matchSlackReviewMessage(
        message({ text: "<@U_ME> https://github.com/other/repo/pull/1" }),
        options,
      ),
    ).toBeNull();
    expect(matchSlackReviewMessage(message(), { ...options, repoList: [] })).toBeNull();
  });

  it("returns only the listed-repo links, canonicalised", () => {
    expect(
      matchSlackReviewMessage(
        message({
          text: "<@U_ME> https://github.com/other/repo/pull/1 <https://github.com/acme/widget.js/pull/4|pr>",
        }),
        options,
      )?.urls,
    ).toEqual(["https://github.com/Acme/Widget.js/pull/4"]);
  });

  it("restricts channels but not DMs; an empty channel list means all", () => {
    expect(matchSlackReviewMessage(message(), { ...options, channelIds: ["C_OTHER"] })).toBeNull();
    expect(
      matchSlackReviewMessage(message(), { ...options, channelIds: ["C_CHANNEL"] }),
    ).not.toBeNull();
    expect(matchSlackReviewMessage(message(), { ...options, channelIds: [] })).not.toBeNull();
    expect(
      matchSlackReviewMessage(message({ channel_type: "im" }), {
        ...options,
        channelIds: ["C_OTHER"],
      }),
    ).not.toBeNull();
  });

  it("respects active hours by the message's own ts (UTC+8, [9,19))", () => {
    const hours = { start: 9, end: 19 };
    const ts = (iso: string) => `${Date.parse(iso) / 1000}.000100`;
    expect(
      matchSlackReviewMessage(message({ ts: ts("2026-10-15T02:00:00Z") }), {
        ...options,
        activeHours: hours,
      }),
    ).not.toBeNull();
    expect(
      matchSlackReviewMessage(message({ ts: ts("2026-10-15T12:00:00Z") }), {
        ...options,
        activeHours: hours,
      }),
    ).toBeNull();
  });
});

describe("characterisation against src/lib/slack-review-rules (repo list = bosinc/katana-web)", () => {
  const legacyList = ["bosinc/katana-web"];

  it("withinActiveHours agrees at every minute of a day around the boundaries", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (ms) => {
        return (
          withinActiveHours(ms, { start: 9, end: 19 }) === legacyHours(ms, { start: 9, end: 19 })
        );
      }),
      { numRuns: 2000 },
    );
  });

  it("extractReviewPrUrls agrees on generated texts", () => {
    const piece = fc.constantFrom(
      url,
      `${url}/files`,
      `${url}/changes/`,
      `<${url}|x>`,
      `[PR](${url})`,
      `${url}suffix`,
      "https://github.com/BOSINC/Katana-Web/pull/5",
      "https://github.com/other/repo/pull/2",
      "https://github.com/bosinc/katana-web/pull/0",
      "https://github.com/bosinc/katana-web/pull/99999999999999999999",
      " ",
      "\n",
      "text",
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 8 }), (parts) => {
        const text = parts.join("");
        expect(extractReviewPrUrls(text, legacyList)).toEqual(legacyExtract(text));
      }),
      { numRuns: 1000 },
    );
  });

  it("matchSlackReviewMessage agrees with the lib (apart from id/key)", () => {
    const events = [
      {},
      { thread_ts: "99.000001" },
      { channel_type: "im" },
      { text: url },
      { bot_id: "B" },
      { subtype: "file_share" },
      { subtype: "message_changed" },
      { ts: "x" },
      { user: "U_ANYONE" },
    ];
    for (const e of events) {
      const legacy = legacyMatch(message(e), { userId: options.userId, teamId: options.teamId });
      const next = matchSlackReviewMessage(message(e), { ...options, repoList: legacyList });
      if (!legacy) expect(next).toBeNull();
      else {
        const { id: _id, ...rest } = legacy;
        const { key: _key, ...nextRest } = next!;
        expect(nextRest).toEqual(rest);
      }
    }
  });
});
