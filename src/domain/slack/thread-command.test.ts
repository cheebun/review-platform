import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseThreadCommand, type ThreadCommandContext } from "./thread-command";

const OWNER = "U_OWNER";
const REQUESTER = "U_REQ";
const ctx: ThreadCommandContext = { ownerId: OWNER, requesterId: REQUESTER };

const reply = (text: string, over: Record<string, unknown> = {}) => ({
  type: "message",
  user: OWNER,
  text,
  channel: "C_REVIEW",
  channel_type: "channel",
  ts: "200.000002",
  thread_ts: "100.000001",
  ...over,
});

const command = (event: unknown, c: ThreadCommandContext = ctx) => {
  const parsed = parseThreadCommand(event, c);
  return parsed.kind === "command" ? parsed.command : `ignored:${parsed.reason}`;
};

describe("parseThreadCommand: commands (FR-SLACK-13)", () => {
  it("returns the command with its thread coordinates", () => {
    expect(parseThreadCommand(reply("merge"), ctx)).toEqual({
      kind: "command",
      command: "merge",
      sender: OWNER,
      channel: "C_REVIEW",
      threadTs: "100.000001",
      ts: "200.000002",
    });
  });

  it.each([
    ["review", "review"],
    ["approve", "approve"],
    ["force approve", "force_approve"],
    ["merge", "merge"],
  ])("owner %s → %s", (text, expected) => {
    expect(command(reply(text))).toBe(expected);
  });

  it("requester updated → updated", () => {
    expect(command(reply("updated", { user: REQUESTER }))).toBe("updated");
  });

  it("matches case-insensitively after trimming (AC 1)", () => {
    for (const text of ["merge", "Merge", "MERGE", "  merge\n", "\tReview ", "UPDATED"])
      expect(
        command(reply(text, text.trim().toLowerCase() === "updated" ? { user: REQUESTER } : {})),
        text,
      ).not.toMatch(/^ignored/);
  });

  it("collapses internal whitespace in force approve", () => {
    for (const text of ["force  approve", "Force\tApprove", " FORCE \n APPROVE ", "force approve"])
      expect(command(reply(text)), JSON.stringify(text)).toBe("force_approve");
  });

  it("thread_broadcast replies still count", () => {
    expect(command(reply("merge", { subtype: "thread_broadcast" }))).toBe("merge");
  });
});

describe("parseThreadCommand: who may send what", () => {
  it("owner commands from anyone else are not_owner, and carry the sender for the log", () => {
    for (const text of ["review", "approve", "force approve", "merge"]) {
      expect(command(reply(text, { user: REQUESTER })), text).toBe("ignored:not_owner");
      expect(command(reply(text, { user: "U_STRANGER" })), text).toBe("ignored:not_owner");
    }
    expect(parseThreadCommand(reply("merge", { user: "U_STRANGER" }), ctx)).toEqual({
      kind: "ignored",
      reason: "not_owner",
      sender: "U_STRANGER",
    });
  });

  it("updated from anyone but the recorded requester, including the owner, is not_requester", () => {
    expect(command(reply("updated"))).toBe("ignored:not_requester");
    expect(command(reply("updated", { user: "U_STRANGER" }))).toBe("ignored:not_requester");
  });

  it("updated with no recorded requester is not_requester", () => {
    expect(command(reply("updated", { user: REQUESTER }), { ownerId: OWNER })).toBe(
      "ignored:not_requester",
    );
  });

  it("does not match ids by prefix or substring", () => {
    expect(command(reply("merge", { user: "U_OWNE" }))).toBe("ignored:not_owner");
    expect(command(reply("merge", { user: "U_OWNERX" }))).toBe("ignored:not_owner");
    expect(command(reply("updated", { user: "U_REQX" }))).toBe("ignored:not_requester");
  });
});

describe("parseThreadCommand: ignored events", () => {
  it("non-command text is unknown_text, before any sender check", () => {
    for (const text of [
      "merge please",
      "please merge",
      "updated please",
      "review please",
      "<@U_OWNER> merge",
      "merge.",
      "`merge`",
      "force",
      "approve force",
      "forceapprove",
      "",
      "   ",
    ]) {
      expect(command(reply(text)), JSON.stringify(text)).toBe("ignored:unknown_text");
      expect(command(reply(text, { user: "U_STRANGER" })), JSON.stringify(text)).toBe(
        "ignored:unknown_text",
      );
    }
  });

  it("edits are ignored even when the new text is a command (AC 2)", () => {
    const edited = {
      type: "message",
      subtype: "message_changed",
      channel: "C_REVIEW",
      ts: "300.000003",
      message: {
        type: "message",
        user: OWNER,
        text: "merge",
        ts: "200.000002",
        thread_ts: "100.000001",
      },
    };
    expect(command(edited)).toBe("ignored:edited");
    expect(command(reply("merge", { subtype: "message_deleted" }))).toBe("ignored:deleted");
    expect(command(reply("merge", { subtype: "channel_join" }))).toBe(
      "ignored:unsupported_subtype",
    );
    expect(command(reply("merge", { subtype: "file_share" }))).toBe("ignored:unsupported_subtype");
  });

  it("bot and hidden messages are ignored", () => {
    expect(command(reply("merge", { bot_id: "B_APP" }))).toBe("ignored:bot");
    expect(command(reply("merge", { subtype: "bot_message" }))).toBe("ignored:bot");
    expect(command(reply("merge", { hidden: true }))).toBe("ignored:hidden");
  });

  it("messages outside a thread, or the thread root itself, are not_thread", () => {
    expect(command(reply("merge", { thread_ts: undefined }))).toBe("ignored:not_thread");
    expect(command(reply("merge", { thread_ts: "200.000002" }))).toBe("ignored:not_thread");
    expect(command(reply("merge", { thread_ts: 5 }))).toBe("ignored:not_thread");
  });

  it("malformed input is invalid_event or not_message, and never throws", () => {
    expect(command(null)).toBe("ignored:invalid_event");
    expect(command("merge")).toBe("ignored:invalid_event");
    expect(command({ ...reply("merge"), type: "app_mention" })).toBe("ignored:not_message");
    expect(command(reply("merge", { text: 1 }))).toBe("ignored:invalid_event");
    expect(command(reply("merge", { user: undefined }))).toBe("ignored:invalid_event");
    expect(command(reply("merge", { channel: undefined }))).toBe("ignored:invalid_event");
    expect(command(reply("merge", { ts: "abc" }))).toBe("ignored:invalid_event");
    expect(command(reply("merge", { thread_ts: "abc" }))).toBe("ignored:not_thread");
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), fc.dictionary(fc.string(), fc.anything()), (raw, over) => {
        const parsed = parseThreadCommand(raw, ctx);
        const parsed2 = parseThreadCommand({ ...reply("merge"), ...over }, ctx);
        return (
          ["command", "ignored"].includes(parsed.kind) &&
          ["command", "ignored"].includes(parsed2.kind)
        );
      }),
      { numRuns: 500 },
    );
  });
});

describe("the app's own posts (sender = owner, user token) never become commands", () => {
  // Realistic texts the app posts in a review thread as the owner (FR-SLACK-08, FR-SLACK-13).
  const appPosts = [
    "on it",
    "review: APPROVE\nP0 0 · P1 0 · P2 2\nauto-approve: approved at 3f2a9c1\nhttps://ops.example/review/r_123\nReply `merge` in this thread to merge.",
    "review: REQUEST_CHANGES\nP0 1 · P1 2\n- P0: SQL injection in search\nauto-approve: skipped (P0)\nThe owner can reply `force approve` to approve anyway.",
    "approved at 3f2a9c1",
    "merged: 9b8c7d6",
    "merge failed: not mergeable",
    "请先 approve（或 force approve）",
    "already merged",
    "上次审核后没有新提交",
    "正在审核中",
    "review failed: the model did not answer",
    "force approved at 3f2a9c1. Reply merge to merge.",
    "merge\napprove",
    "approve merge",
    "Merge? Reply `merge`.",
    "> merge",
  ];

  it.each(appPosts)("%j is unknown_text", (text) => {
    expect(command(reply(text))).toBe("ignored:unknown_text");
  });

  it("no generated text that merely contains a command word becomes a command", () => {
    const word = fc.constantFrom(
      "merge",
      "approve",
      "force",
      "review",
      "updated",
      "Merge",
      "APPROVE",
    );
    const filler = fc.constantFrom(
      "please",
      "at",
      "3f2a9c1",
      ".",
      "`",
      ":",
      "—",
      "已合并",
      "<@U_OWNER>",
    );
    const sep = fc.constantFrom(" ", "\n", "\t", "");
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.oneof(word, filler), sep), { minLength: 1, maxLength: 6 }),
        (parts) => {
          const text = parts.map(([p, s]) => p + s).join("");
          const normalised = text.trim().replace(/\s+/g, " ").toLowerCase();
          const exact = ["review", "approve", "force approve", "merge", "updated"].includes(
            normalised,
          );
          const parsed = parseThreadCommand(reply(text), ctx);
          if (!exact)
            expect(parsed).toEqual({ kind: "ignored", reason: "unknown_text", sender: OWNER });
        },
      ),
      { numRuns: 1000 },
    );
  });
});
