import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractReviewPrUrls,
  matchSlackReviewMessage,
  withinActiveHours,
} from "../src/lib/slack-review-rules";
import { SlackReviewStore, readSlackReviewState } from "../src/lib/slack-review-store";
import { runSlackReviewJob } from "../src/lib/slack-review-runner";

const url = "https://github.com/bosinc/katana-web/pull/17190";
const options = { userId: "U_ME", teamId: "T_TEAM", senderIds: ["U_YETIAN", "U_ZUODAJIANG"] };
function message(event: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T_TEAM",
    event_id: "Ev1",
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
  };
}

test("matches canonical, Slack, Markdown and multiple links; rejects other repositories", () => {
  assert.deepEqual(
    extractReviewPrUrls(
      `[PR](${url}) <${url}/files|review> ${url}?foo=1 https://github.com/other/repo/pull/2`,
    ),
    [url],
  );
  assert.deepEqual(extractReviewPrUrls(`${url} https://github.com/bosinc/katana-web/pull/17191`), [
    url,
    url.replace("17190", "17191"),
  ]);
  assert.deepEqual(
    extractReviewPrUrls(`${url}suffix https://github.com/bosinc/katana-web/pull/0`),
    [],
  );
});

test("recognizes GitHub changes links and normalizes them before queueing", () => {
  const changesUrl = "https://github.com/bosinc/katana-web/pull/17199/changes";
  const canonical = "https://github.com/bosinc/katana-web/pull/17199";
  for (const text of [
    changesUrl,
    `<${changesUrl}>`,
    `<${changesUrl}|Review PR>`,
    `[PR](${changesUrl})`,
    `${changesUrl}/?foo=1#diff-123`,
  ]) {
    assert.deepEqual(extractReviewPrUrls(text), [canonical]);
    const matched = matchSlackReviewMessage(
      message({ text: `<@U_ME> ${text}`, channel_type: "im" }),
      options,
    );
    assert.deepEqual(matched?.urls, [canonical]);
  }
  assert.deepEqual(extractReviewPrUrls(`${changesUrl}suffix`), []);
  assert.deepEqual(extractReviewPrUrls(changesUrl.replace("bosinc/katana-web", "other/repo")), []);
});

test("requires an explicit personal mention and respects channel restriction", () => {
  assert.ok(matchSlackReviewMessage(message(), options));
  assert.equal(
    matchSlackReviewMessage(message({ thread_ts: "99.000001" }), options)?.threadTs,
    "99.000001",
  );
  assert.equal(matchSlackReviewMessage(message({ text: url, channel_type: "im" }), options), null);
  for (const event of [
    { text: url },
    { bot_id: "B_BOT" },
    { subtype: "message_changed" },
    { subtype: "message_deleted" },
    { text: `<@U_BOT> ${url}` },
  ])
    assert.equal(matchSlackReviewMessage(message(event), options), null);
  assert.equal(matchSlackReviewMessage({ ...message(), team_id: "T_OTHER" }, options), null);
  assert.equal(
    matchSlackReviewMessage(
      {
        ...message({ channel_type: "im" }),
        authorizations: [{ user_id: "U_OTHER", is_bot: false }],
      },
      options,
    ),
    null,
  );
  assert.equal(matchSlackReviewMessage(message(), { ...options, channelIds: ["C_OTHER"] }), null);
  assert.ok(
    matchSlackReviewMessage(message({ channel_type: "im" }), {
      ...options,
      channelIds: ["C_OTHER"],
    }),
  );
});

test("responds only to messages sent between 09:00 and 19:00 UTC+8", () => {
  const hours = { start: 9, end: 19 };
  const utc = (iso: string) => Date.parse(iso);
  assert.equal(withinActiveHours(utc("2026-10-15T00:59:59Z"), hours), false);
  assert.equal(withinActiveHours(utc("2026-10-15T01:00:00Z"), hours), true);
  assert.equal(withinActiveHours(utc("2026-10-15T10:59:59Z"), hours), true);
  assert.equal(withinActiveHours(utc("2026-10-15T11:00:00Z"), hours), false);
  const ts = (iso: string) => `${utc(iso) / 1000}.000100`;
  assert.ok(
    matchSlackReviewMessage(message({ ts: ts("2026-10-15T02:00:00Z") }), {
      ...options,
      activeHours: hours,
    }),
  );
  assert.equal(
    matchSlackReviewMessage(message({ ts: ts("2026-10-15T12:00:00Z") }), {
      ...options,
      activeHours: hours,
    }),
    null,
  );
});

test("any sender can trigger when explicitly mentioning me", () => {
  for (const channel_type of ["im", "channel"]) {
    assert.ok(matchSlackReviewMessage(message({ user: "U_ME", channel_type }), options));
    assert.ok(matchSlackReviewMessage(message({ user: "U_OTHER", channel_type }), options));
    assert.equal(
      matchSlackReviewMessage(message({ user: "U_ME", channel_type, text: url }), options),
      null,
    );
  }
});

test("any sender can trigger from DMs, channels, groups and threads when mentioned", () => {
  for (const channel_type of ["im", "channel", "group", "mpim"]) {
    assert.ok(
      matchSlackReviewMessage(
        message({ user: "U_OTHER", channel_type, thread_ts: "99.000001" }),
        options,
      ),
    );
    assert.ok(matchSlackReviewMessage(message({ channel_type }), { ...options, senderIds: [] }));
  }
});

test("persisted jobs from any sender can Ship and react", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-slack-test-"));
  try {
    for (const status of ["queued", "reaction_pending"] as const) {
      const store = await SlackReviewStore.open(join(directory, `${status}.json`));
      const matched = matchSlackReviewMessage(message({ user: "U_OTHER" }), options)!;
      await store.enqueue(matched, "zhiyong-eng");
      const job = store.state.jobs[0];
      job.status = status;
      job.nextAttemptAt = 1;
      const calls: string[] = [];
      await runSlackReviewJob(store, job, {
        senderIds: options.senderIds,
        ship: async () => {
          calls.push("ship");
        },
        react: async () => {
          calls.push("react");
        },
      });
      assert.equal(job.status, "done");
      assert.deepEqual(calls, status === "queued" ? ["ship", "react"] : ["react"]);
      assert.equal(
        (await readSlackReviewState(join(directory, `${status}.json`))).jobs[0].status,
        "done",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deduplicates delivery and restores interrupted jobs from disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-slack-test-"));
  try {
    const file = join(directory, "state.json");
    const store = await SlackReviewStore.open(file);
    const matched = matchSlackReviewMessage(message(), options)!;
    assert.deepEqual(
      await Promise.all([
        store.enqueue(matched, "zhiyong-eng"),
        store.enqueue(matched, "zhiyong-eng"),
      ]),
      [true, false],
    );
    store.state.jobs[0].status = "running";
    await store.save();
    const restored = await SlackReviewStore.open(file);
    assert.equal(restored.state.jobs.length, 1);
    assert.equal(restored.state.jobs[0].status, "queued");
    assert.equal(await restored.enqueue(matched, "wgbx"), false);
    assert.equal((await readSlackReviewState(file)).jobs[0].account, "zhiyong-eng");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reacts only after all PRs finish and retries only a failed reaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-slack-test-"));
  try {
    const file = join(directory, "state.json");
    const store = await SlackReviewStore.open(file);
    const matched = matchSlackReviewMessage(
      message({ text: `<@U_ME> ${url} ${url.replace("17190", "17191")}` }),
      options,
    )!;
    await store.enqueue(matched, "zhiyong-eng");
    const job = store.state.jobs[0];
    const calls: string[] = [];
    const ship = async (pr: string) => {
      calls.push(pr);
    };
    await runSlackReviewJob(store, job, {
      senderIds: options.senderIds,
      ship,
      react: async () => {
        calls.push("reaction-failed");
        throw new Error("Slack temporary failure");
      },
    });
    assert.equal(job.status, "reaction_pending");
    assert.deepEqual(calls, [...matched.urls, "reaction-failed"]);
    const restored = await SlackReviewStore.open(file);
    await runSlackReviewJob(restored, restored.state.jobs[0], {
      senderIds: options.senderIds,
      ship,
      react: async (channel, ts) => {
        assert.equal(channel, matched.channel);
        assert.equal(ts, matched.ts);
        calls.push("reaction-success");
      },
    });
    assert.equal(restored.state.jobs[0].status, "done");
    assert.deepEqual(calls, [...matched.urls, "reaction-failed", "reaction-success"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replies with approved, the P0 comment link, or minor-issues approval before ✅", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-slack-test-"));
  try {
    const makeProgress = (severity?: "P0" | "P1") => ({
      pr: {
        owner: "bosinc",
        repo: "katana-web",
        number: 17190,
        title: "Test",
        author: "author",
        htmlUrl: url,
        base: "main",
        head: "test",
        sha: "head",
        baseSha: "base",
      },
      review: {
        summary: "",
        findings: severity ? [{ severity, title: "Finding", body: "Details" }] : [],
        verificationRequests: [],
      },
      commentId: 123,
    });
    for (const [severity, expected] of [
      [undefined, "approved"],
      ["P0", `<${url}#issuecomment-123|see comment>`],
      ["P1", "approved with minor issues"],
    ] as const) {
      const store = await SlackReviewStore.open(join(directory, `${severity}.json`));
      await store.enqueue(matchSlackReviewMessage(message(), options)!, "zhiyong-eng");
      const replies: string[] = [];
      const calls: string[] = [];
      await runSlackReviewJob(store, store.state.jobs[0], {
        senderIds: options.senderIds,
        ship: async (_url, _account, { progress }) =>
          Object.assign(progress, makeProgress(severity)),
        reply: async (_channel, _ts, _threadTs, text) => {
          replies.push(text!);
          calls.push("reply");
        },
        react: async () => {
          calls.push("react");
        },
      });
      assert.deepEqual(replies, [expected]);
      assert.deepEqual(calls, ["reply", "react"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed Ship never marks the Slack message done; manual retry retains checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-slack-test-"));
  try {
    const file = join(directory, "state.json");
    const store = await SlackReviewStore.open(file);
    await store.enqueue(matchSlackReviewMessage(message(), options)!, "zhiyong-eng");
    let reactions = 0;
    await runSlackReviewJob(store, store.state.jobs[0], {
      senderIds: options.senderIds,
      ship: async (_url, _account, { progress, checkpoint }) => {
        progress.commentId = 42;
        await checkpoint(progress);
        throw new Error("Merge failed");
      },
      react: async () => {
        reactions++;
      },
    });
    assert.equal(store.state.jobs[0].status, "failed");
    assert.equal(reactions, 0);
    const noRetry = await SlackReviewStore.open(file);
    assert.equal(noRetry.state.jobs[0].status, "failed");
    const retry = await SlackReviewStore.open(file, true);
    assert.equal(retry.state.jobs[0].status, "queued");
    assert.equal(retry.state.jobs[0].progress[url].commentId, 42);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a failed Ship in Slack without adding ✅", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-slack-test-"));
  try {
    const store = await SlackReviewStore.open(join(directory, "state.json"));
    await store.enqueue(matchSlackReviewMessage(message(), options)!, "zhiyong-eng");
    const replies: string[] = [];
    let reacted = false;
    await runSlackReviewJob(store, store.state.jobs[0], {
      senderIds: options.senderIds,
      ship: async () => {
        throw new Error("PR 已合并，跳过自动 Review。");
      },
      reply: async (_channel, _ts, _threadTs, text) => {
        replies.push(text!);
      },
      react: async () => {
        reacted = true;
      },
    });
    assert.equal(store.state.jobs[0].status, "failed");
    assert.deepEqual(replies, ["review failed: PR 已合并，无法继续处理。"]);
    assert.equal(store.state.jobs[0].error, "PR 已合并，跳过自动 Review。");
    assert.equal(reacted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed multi-PR message resumes only the unfinished PR", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-slack-test-"));
  try {
    const store = await SlackReviewStore.open(join(directory, "state.json"));
    const second = url.replace("17190", "17191");
    await store.enqueue(
      matchSlackReviewMessage(message({ text: `<@U_ME> ${url} ${second}` }), options)!,
      "zhiyong-eng",
    );
    const calls: string[] = [];
    const dependencies = {
      senderIds: options.senderIds,
      ship: async (pr: string) => {
        calls.push(pr);
        if (pr === second) throw new Error("Second PR blocked");
      },
      react: async () => {},
    };
    await runSlackReviewJob(store, store.state.jobs[0], dependencies);
    assert.equal(store.state.jobs[0].status, "failed");
    const restored = await SlackReviewStore.open(join(directory, "state.json"), true);
    await runSlackReviewJob(restored, restored.state.jobs[0], {
      ...dependencies,
      ship: async (pr) => {
        calls.push(pr);
      },
    });
    assert.deepEqual(calls, [url, second, second]);
    assert.equal(restored.state.jobs[0].status, "done");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
