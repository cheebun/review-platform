import { describe, expect, it } from "vitest";
import { ok } from "../../domain/shared/result";
import { CHANGES, FORCE_APPROVED, MERGED, PENDING } from "../../domain/slack/status-emoji";
import { blocking, CHANNEL, PR1, PR2, SHA_A, SHA_B, T0 } from "../review/harness.test-support";
import {
  messageEnvelope,
  mention,
  OTHER,
  OWNER,
  ROOT_TS,
  slackHarness,
  tsAt,
} from "./slack.test-support";

const ref1 = { owner: "acme", repo: "app", number: 1 };
let replySeq = 1000;
const reply = (text: string, user = OWNER) =>
  messageEnvelope({ text, user, ts: tsAt(T0, (replySeq += 1)), threadTs: ROOT_TS });

/** A thread whose PR1 review finished: 🔴 by default; 🟢 without auto-approve with `pass`. */
async function reviewedThread(opts: { verdict?: "red" | "pass"; urls?: string[] } = {}) {
  const s = await slackHarness();
  if (opts.verdict !== "pass") s.reviewer.answers = [ok(blocking())];
  const urls = opts.urls ?? [PR1];
  await s.deliver(messageEnvelope({ text: mention(urls.join(" ")) }));
  // Auto-approve is skipped while the repo list is empty during the run.
  if (opts.verdict === "pass") s.setRepos([]);
  await s.runConsumer();
  s.setRepos(["acme/app"]);
  await s.drainReactions();
  s.replier.replies.length = 0;
  return s;
}

const approvals = (s: Awaited<ReturnType<typeof slackHarness>>) =>
  s.reviews().filter((r) => r.state === "APPROVED");

describe("owner commands (FR-SLACK-13)", () => {
  it("approve on 🔴 is refused and points to force approve", async () => {
    const s = await reviewedThread();
    expect(s.reactions()).toEqual([CHANGES]);
    await s.deliver(reply("approve"));
    expect(approvals(s)).toEqual([]);
    expect(s.replies()).toHaveLength(1);
    expect(s.replies()[0]).toContain("force approve");
    expect(s.replier.replies[0]).toMatchObject({ channel: CHANNEL, threadTs: ROOT_TS });
  });

  it("force approve approves despite 🔴 and turns it 🟡", async () => {
    const s = await reviewedThread();
    await s.deliver(reply("Force  Approve"));
    expect(approvals(s).map((r) => r.commitId)).toEqual([SHA_A]);
    expect(s.replies()[0]).toContain("force approve");
    expect(s.replies()[0]).toContain(SHA_A.slice(0, 7));
    await s.drainReactions();
    expect(s.reactions()).toEqual([FORCE_APPROVED]);
    const events = await s.events.list({ prUrl: PR1, types: ["force_approved"], limit: 5 });
    expect(events[0]).toMatchObject({
      actor: { kind: "user", id: `slack:${OWNER}` },
      source: "slack",
    });
  });

  it("merge without an approval replies with the gate checklist and writes nothing", async () => {
    const s = await reviewedThread({ verdict: "pass" });
    await s.deliver(reply("merge"));
    expect(s.world.count("merge")).toBe(0);
    expect(approvals(s)).toEqual([]);
    const text = s.replies()[0]!;
    expect(text).toContain("请先 approve（或 force approve）");
    expect(text).toContain(":x: 当前提交已 approve");
    expect(text).toContain(":white_check_mark: 仓库在列表中");
  });

  it("approve then merge: one APPROVE, one merge, ✅ next to 🟢", async () => {
    const s = await reviewedThread({ verdict: "pass" });
    await s.deliver(reply("approve"));
    expect(s.replies()[0]).toContain("已 approve");
    await s.deliver(reply("MERGE"));
    expect(approvals(s)).toHaveLength(1);
    expect(s.world.count("merge")).toBe(1);
    expect(s.replies()[1]).toContain("已合并");
    await s.drainReactions();
    expect(s.reactions()).toEqual(["large_green_circle", MERGED].toSorted());
    await s.deliver(reply("merge"));
    expect(s.replies()[2]).toContain("已经合并");
    expect(s.world.count("merge")).toBe(1);
  });

  it("commands from anyone but the owner do nothing and are logged", async () => {
    const s = await reviewedThread();
    for (const text of ["merge", "approve", "force approve", "review"]) {
      await s.deliver(reply(text, OTHER));
    }
    expect(s.replies()).toEqual([]);
    expect(approvals(s)).toEqual([]);
    expect(s.logger.entries.filter((e) => e.msg === "thread command ignored")).toHaveLength(4);
    expect(s.logger.entries.find((e) => e.msg === "thread command ignored")!.fields).toMatchObject({
      sender: OTHER,
      reason: "not_owner",
    });
  });

  it("a command text with more words is not a command", async () => {
    const s = await reviewedThread();
    await s.deliver(reply("merge please"));
    expect(s.replies()).toEqual([]);
  });

  it("an edited message that becomes merge does nothing", async () => {
    const s = await reviewedThread({ verdict: "pass" });
    await s.deliver(
      messageEnvelope({
        text: "merge",
        user: OWNER,
        threadTs: ROOT_TS,
        subtype: "message_changed",
      }),
    );
    expect(s.replies()).toEqual([]);
  });

  it("a thread with no review does nothing and is logged", async () => {
    const s = await slackHarness();
    await s.deliver(reply("merge"));
    expect(s.replies()).toEqual([]);
    expect(s.logger.entries.map((e) => e.msg)).toContain("thread command for an unknown thread");
  });

  it("a thread with two PRs gets a disambiguation reply and no GitHub writes", async () => {
    const s = await reviewedThread({ urls: [PR1, PR2] });
    await s.deliver(reply("force approve"));
    expect(approvals(s)).toEqual([]);
    expect(s.replies()[0]).toContain(PR1);
    expect(s.replies()[0]).toContain(PR2);
  });

  it("a GitHub outage gets a generic reply, never the raw error", async () => {
    const s = await reviewedThread({ verdict: "pass" });
    s.world.failNext({ kind: "bad_gateway" }, 10);
    await s.deliver(reply("approve"));
    expect(s.replies()[0]).toMatch(/GitHub/);
    expect(s.replies()[0]).not.toMatch(/500|Error|stack/i);
  });
});

describe("re-review (FR-SLACK-14)", () => {
  it("updated from the requester with no new commits only replies", async () => {
    const s = await reviewedThread();
    await s.deliver(reply("updated", "U0ALICE"));
    expect(s.replies()).toEqual(["上次审核后没有新提交"]);
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(s.reactions()).toEqual([CHANGES]);
  });

  it("updated from anyone else, even the owner, is ignored and logged", async () => {
    const s = await reviewedThread();
    s.world.pushHead(ref1, SHA_B);
    await s.deliver(reply("updated", OWNER));
    await s.deliver(reply("updated", OTHER));
    expect(s.replies()).toEqual([]);
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
    expect(
      s.logger.entries
        .filter((e) => e.msg === "thread command ignored")
        .map((e) => e.fields.reason),
    ).toEqual(["not_requester", "not_requester"]);
  });

  it("updated after new commits enqueues a round on the original message with ⏳", async () => {
    const s = await reviewedThread();
    s.world.pushHead(ref1, SHA_B);
    s.wakes.length = 0;
    await s.deliver(reply("updated", "U0ALICE"));
    const jobs = await s.jobs.listRecent({ limit: 10 });
    expect(jobs).toHaveLength(2);
    const job = jobs.find((j) => j.state === "queued")!;
    expect(job.slack).toEqual({
      channel: CHANNEL,
      ts: ROOT_TS,
      threadTs: ROOT_TS,
      user: "U0ALICE",
    });
    expect(s.wakes).toEqual(["review-job:wake"]);
    await s.drainReactions();
    expect(s.reactions()).toEqual([PENDING]);
  });

  it("updated outside active hours replies with the hours", async () => {
    const s = await reviewedThread();
    s.world.pushHead(ref1, SHA_B);
    const night = new Date("2026-11-04T12:00:00.000Z");
    await s.deliver(
      messageEnvelope({ text: "updated", user: "U0ALICE", ts: tsAt(night), threadTs: ROOT_TS }),
    );
    expect(s.replies()[0]).toContain("09:00");
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(1);
  });

  it("owner review re-runs on the same SHA and says so", async () => {
    const s = await reviewedThread();
    await s.deliver(reply("review"));
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(2);
    expect(s.replies()[0]).toContain("同一提交");
  });

  it("review while a review is queued replies 正在审核中 and enqueues nothing", async () => {
    const s = await reviewedThread();
    await s.deliver(reply("review"));
    await s.deliver(reply("review"));
    expect(await s.jobs.listRecent({ limit: 10 })).toHaveLength(2);
    expect(s.replies()[1]).toBe("正在审核中");
  });
});
