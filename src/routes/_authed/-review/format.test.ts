import { describe, expect, it } from "vitest";
import {
  approvalText,
  eventLabel,
  formatTime,
  markerText,
  requesterText,
  severityLabel,
} from "./format";
import { validateReviewSearch } from "./search";

describe("validateReviewSearch", () => {
  it("keeps valid filters", () => {
    expect(
      validateReviewSearch({
        repo: "acme/web",
        outcome: "pass",
        source: "slack",
        from: "2026-11-01",
        to: "2026-11-04",
      }),
    ).toEqual({
      repo: "acme/web",
      outcome: "pass",
      source: "slack",
      from: "2026-11-01",
      to: "2026-11-04",
    });
  });

  it("drops anything malformed instead of failing the page", () => {
    expect(
      validateReviewSearch({
        repo: "<script>",
        outcome: "merged",
        source: 3,
        from: "yesterday",
        to: "",
        extra: "x",
      }),
    ).toEqual({});
  });
});

describe("format", () => {
  it("markers match Slack; a failed review has none", () => {
    expect(markerText("pass")).toBe("🟢 通过");
    expect(markerText("changes_requested")).toBe("🔴 需修改");
    expect(markerText("force_approved")).toBe("🟡 强制批准");
    expect(markerText(null)).toBeNull();
  });

  it("approve outcome text, with the skip reason in words", () => {
    expect(approvalText(null)).toBe("未批准");
    expect(approvalText({ kind: "approved", at: "x", source: "system" })).toBe(
      "已批准（auto: review passed）",
    );
    expect(approvalText({ kind: "approved", at: "x", source: "slack" })).toBe("已批准");
    expect(approvalText({ kind: "force_approved", at: "x" })).toBe("🟡 强制批准");
    expect(approvalText({ kind: "skipped", at: "x", reason: "sha_changed" })).toBe(
      "已跳过：PR 有新提交",
    );
    expect(approvalText({ kind: "skipped", at: "x", reason: "own_pr" })).toBe("已跳过：自己的 PR");
    expect(approvalText({ kind: "skipped", at: "x", reason: "something_new" })).toBe(
      "已跳过：something_new",
    );
    expect(approvalText({ kind: "failed", at: "x" })).toBe("批准失败");
  });

  it("requester", () => {
    expect(requesterText({ kind: "user", id: "u1", self: true })).toBe("你");
    expect(requesterText({ kind: "user", id: "u2", self: false })).toBe("用户 u2");
    expect(requesterText({ kind: "slack", id: "U123", self: false })).toBe("Slack U123");
    expect(requesterText({ kind: "machine", id: "machine", self: false })).toBe("machine");
  });

  it("time is shown in UTC+8", () => {
    expect(formatTime("2026-11-03T23:30:00.000Z")).toBe("2026-11-04 07:30");
    expect(formatTime("not a date")).toBe("not a date");
  });

  it("labels", () => {
    expect(severityLabel("P0")).toBe("P0 阻塞");
    expect(severityLabel("Nit")).toBe("Nit 微调");
    expect(severityLabel("P9")).toBe("P9");
    expect(eventLabel("merged")).toBe("✅ 已合并");
    expect(eventLabel("review_finished")).toBe("评审完成");
  });
});
