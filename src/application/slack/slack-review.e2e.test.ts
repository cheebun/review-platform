/**
 * End to end with fakes (FR-SLACK-14 acceptance scenario): mention → ⏳ → review 🔴 → new commits
 * and `updated` → ⏳ → 🟢 with auto-approve → `merge` → ✅ next to 🟢.
 */
import { describe, expect, it } from "vitest";
import { ok } from "../../domain/shared/result";
import { CHANGES, MERGED, PASSED, PENDING } from "../../domain/slack/status-emoji";
import { blocking, CHANNEL, PR1, SHA_B, T0, passing } from "../review/harness.test-support";
import { messageEnvelope, mention, OWNER, ROOT_TS, slackHarness, tsAt } from "./slack.test-support";

const ref1 = { owner: "acme", repo: "app", number: 1 };

describe("Slack review, end to end", () => {
  it("mention → ⏳ → 🔴 → updated → ⏳ → 🟢 (auto-approved) → merge → ✅", async () => {
    const s = await slackHarness();
    s.reviewer.answers = [ok(blocking()), ok(passing())];

    await s.deliver(messageEnvelope({ text: mention(`please review ${PR1}`) }));
    expect(s.replies()).toEqual(["on it"]);
    await s.drainReactions();
    expect(s.reactions()).toEqual([PENDING]);

    expect(await s.runConsumer()).toMatchObject({ kind: "processed", state: "done" });
    await s.drainReactions();
    expect(s.reactions()).toEqual([CHANGES]);
    expect(s.reviews().filter((r) => r.state === "APPROVED")).toEqual([]);

    s.world.pushHead(ref1, SHA_B);
    await s.deliver(
      messageEnvelope({ text: "updated", user: "U0ALICE", ts: tsAt(T0, 500), threadTs: ROOT_TS }),
    );
    await s.drainReactions();
    expect(s.reactions()).toEqual([PENDING]);

    expect(await s.runConsumer()).toMatchObject({ kind: "processed", state: "done" });
    await s.drainReactions();
    expect(s.reactions()).toEqual([PASSED]);
    const approvals = s.reviews().filter((r) => r.state === "APPROVED");
    expect(approvals.map((r) => r.commitId)).toEqual([SHA_B]);

    await s.deliver(
      messageEnvelope({ text: "merge", user: OWNER, ts: tsAt(T0, 600), threadTs: ROOT_TS }),
    );
    expect(s.world.count("merge")).toBe(1);
    expect(s.world.getPr(ref1)!.merged).toBe(true);
    await s.drainReactions();
    expect(s.reactions()).toEqual([PASSED, MERGED].toSorted());
    expect(s.reviews().filter((r) => r.state === "APPROVED")).toHaveLength(1);

    const threadReplies = s.replier.replies.filter((r) => r.threadTs === ROOT_TS);
    expect(threadReplies.every((r) => r.channel === CHANNEL)).toBe(true);
    expect(threadReplies.at(-1)!.text).toContain("已合并");
  });
});
