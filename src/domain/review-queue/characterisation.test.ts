/**
 * Characterisation: the same scenarios run through today's `src/lib` logic and through the pure state
 * machine must end in the same observable outcome. This is the only place that imports `src/lib`; it is
 * deleted together with the legacy modules at the end of P3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewDeferredError } from "../../lib/review-input";
import {
  processSlackReviewJob,
  retryFailedSlackReviewJobs,
  type SlackReviewQueue,
} from "../../lib/slack-review-queue";
import type { RunnerDependencies } from "../../lib/slack-review-runner";
import type { SlackReviewJob } from "../../lib/slack-review-store";
import { aReviewJobInState } from "../../testing/builders/review-job";
import { step, transition, type ReviewJobEvent } from "./state-machine";
import type { ReactionIntent, ReviewJob, ReviewJobState } from "./types";

const NOW = new Date("2026-01-01T00:10:00.000Z");
const URLS = [
  "https://github.com/bosinc/katana-web/pull/1",
  "https://github.com/bosinc/katana-web/pull/2",
];
const REVIEW = { summary: "s", findings: [], verificationRequests: [] };
const prOf = (url: string) => ({
  owner: "bosinc",
  repo: "katana-web",
  number: Number(url.split("/").pop()),
  title: "t",
  author: "dev",
  htmlUrl: url,
  base: "main",
  head: "f",
  sha: `sha-${url.split("/").pop()}`,
  baseSha: "b",
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

type Outcome = "ok" | "defer" | "throw";
type Start = {
  state: "queued" | "running" | "reaction_pending";
  interruptions?: number;
  replySent?: boolean;
  dueIn?: number;
};
type Scenario = { start: Start; ship: [Outcome, Outcome]; react: "ok" | "throw" };

type Observed = {
  state: ReviewJobState | "reaction_pending";
  hasError: boolean;
  nextAttemptAt: number | null;
  interruptions: number;
  replySent: boolean;
  completed: string[];
  replies: number;
  reacted: boolean;
  ran: boolean;
};

class OneJobQueue {
  locked = false;
  constructor(public job: SlackReviewJob) {}
  asQueue(): SlackReviewQueue {
    return {
      get: async () => structuredClone(this.job),
      save: async (job: SlackReviewJob) => {
        this.job = structuredClone(job);
      },
      lock: async () => !this.locked && (this.locked = true),
      unlock: async () => {
        this.locked = false;
      },
    } as unknown as SlackReviewQueue;
  }
}

function oldJob(s: Start, completedUrls: string[]): SlackReviewJob {
  return {
    id: "j",
    channel: "C",
    ts: "1.1",
    sender: "U",
    urls: URLS,
    account: "acme" as never,
    status: s.state,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    progress: Object.fromEntries(completedUrls.map((u) => [u, { completed: true }])),
    interruptions: s.interruptions,
    resultReplySent: s.replySent,
    nextAttemptAt: s.dueIn === undefined ? undefined : NOW.getTime() + s.dueIn,
  };
}

async function runOld(sc: Scenario): Promise<Observed> {
  const completed = sc.start.state === "reaction_pending" ? URLS : [];
  const queue = new OneJobQueue(oldJob(sc.start, completed));
  let replies = 0;
  let reacted = false;
  const outcomes = new Map(URLS.map((u, i) => [u, sc.ship[i]!]));
  const deps = {
    reply: async () => {
      replies++;
    },
    react: async () => {
      if (sc.react === "throw") throw new Error("slack down");
      reacted = true;
    },
    ship: async (
      url: string,
      _a: unknown,
      o: { progress: Record<string, unknown>; checkpoint: (p: never) => Promise<void> },
    ) => {
      const outcome = outcomes.get(url)!;
      // Like the real ship: mutate the shared progress object, then checkpoint it.
      o.progress.review = REVIEW;
      await o.checkpoint(o.progress as never);
      if (outcome === "defer") throw new ReviewDeferredError();
      if (outcome === "throw") throw new Error("github down");
    },
  } as unknown as RunnerDependencies;
  const ran = await processSlackReviewJob(queue.asQueue(), "j", deps);
  const j = queue.job;
  return {
    state: j.status,
    hasError: Boolean(j.error),
    nextAttemptAt: j.nextAttemptAt ?? null,
    interruptions: j.interruptions ?? 0,
    replySent: Boolean(j.resultReplySent),
    completed: URLS.filter((u) => j.progress[u]?.completed),
    replies,
    reacted,
    ran,
  };
}

/**
 * The runner's decisions, expressed as events (this is what the application layer will do).
 * DEVIATION D9: there is no reaction step. The verdict reaction is an outbox intent produced by the
 * terminal transition, so `reacted` means "a pass intent was handed to the outbox" and a Slack failure
 * can no longer hold the job back (see the separate deviation test).
 */
function runNew(sc: Scenario): Observed {
  const start = sc.start as Start & { state: "queued" | "running" };
  let job: ReviewJob = aReviewJobInState(start.state, {
    urls: URLS,
    progress: {},
    interruptions: sc.start.interruptions,
    resultReplySent: sc.start.replySent,
    nextAttemptAt: sc.start.dueIn === undefined ? null : new Date(NOW.getTime() + sc.start.dueIn),
    leaseOwner: sc.start.state === "running" ? "dead" : null,
    leaseUntil: sc.start.state === "running" ? new Date(NOW.getTime() - 1) : null,
  });
  let replies = 0;
  let ran = true;
  const intents: ReactionIntent[] = [];
  const apply = (event: ReviewJobEvent): boolean => {
    const r = step(job, event, NOW);
    if (!r.ok) return false;
    job = r.value.job;
    intents.push(...r.value.intents);
    return true;
  };
  const stopped = () => job.state === "failed" || job.state === "queued";
  if (job.state === "running" && !apply({ type: "lease_expired" })) ran = false;
  if ((ran && !stopped()) || (ran && job.state === "queued")) {
    if (job.state === "failed") {
      // interruption limit reached: runner does not reply today
    } else if (!apply({ type: "claimed", owner: "w", leaseMs: 330_000 })) ran = false;
  }
  if (ran && job.state === "running") {
    for (const [i, url] of URLS.entries()) {
      if (job.progress[url]?.completed) continue;
      apply({ type: "checkpoint", url, patch: { pr: prOf(url), review: REVIEW } });
      const outcome = sc.ship[i]!;
      if (outcome === "defer") {
        apply({ type: "deferred" });
        break;
      }
      if (outcome === "throw") {
        apply({ type: "failed", error: "github down" });
        replies++;
        apply({ type: "reply_sent" });
        break;
      }
      // 🟢: comment, then the auto-approve checkpoint, then the URL completes.
      apply({ type: "checkpoint", url, patch: { commented: true } });
      apply({ type: "approve_started", url, sha: prOf(url).sha });
      apply({
        type: "approve_finished",
        url,
        outcome: { step: "approved", sha: prOf(url).sha, githubReviewId: 1 },
      });
      apply({ type: "url_completed", url });
    }
    if (job.state === "running" && apply({ type: "all_completed" })) {
      // "approved" reply: sent once, after the terminal transition.
      replies++;
      apply({ type: "reply_sent" });
    }
  }
  const reacted = job.state === "done" && intents.some((i) => i.target === "pass");
  return {
    state: job.state,
    hasError: Boolean(job.lastError),
    nextAttemptAt: job.nextAttemptAt?.getTime() ?? null,
    interruptions: job.interruptions ?? 0,
    replySent: Boolean(job.resultReplySent),
    completed: URLS.filter((u) => job.progress[u]?.completed),
    replies,
    reacted,
    ran,
  };
}

const outcomes: Outcome[] = ["ok", "defer", "throw"];
const starts: Start[] = [
  { state: "queued" },
  { state: "queued", interruptions: 1 },
  { state: "running", interruptions: undefined },
  { state: "running", interruptions: 1 },
  { state: "running", interruptions: 2 },
];
// Reactions always succeed here: a failing reaction is DEVIATION D9 (tested below).
const scenarios: Scenario[] = starts.flatMap((start) =>
  outcomes.flatMap((a) =>
    outcomes.map((b) => ({ start, ship: [a, b] as [Outcome, Outcome], react: "ok" as const })),
  ),
);

describe("runner + queue: old lib and new state machine agree", () => {
  it(`${scenarios.length} scenarios`, async () => {
    for (const sc of scenarios) {
      const [old, fresh] = [await runOld(sc), runNew(sc)];
      expect({ sc, ...fresh }).toEqual({ sc, ...old });
    }
  });

  it("covers every terminal outcome", async () => {
    const seen = new Set<string>();
    for (const sc of scenarios) seen.add((await runOld(sc)).state + (await runOld(sc)).ran);
    expect([...seen].toSorted()).toEqual(["donetrue", "failedtrue", "queuedtrue"].toSorted());
  });

  it("DEVIATION D9: a failing reaction holds the old job in reaction_pending; the new job is done and hands the reaction to the outbox", async () => {
    const sc: Scenario = { start: { state: "queued" }, ship: ["ok", "ok"], react: "throw" };
    const old = await runOld(sc);
    expect(old).toMatchObject({ state: "reaction_pending", hasError: true, reacted: false });
    expect(old.nextAttemptAt).toBe(NOW.getTime() + 30_000);
    const fresh = runNew(sc);
    expect(fresh).toMatchObject({
      state: "done",
      hasError: false,
      nextAttemptAt: null,
      reacted: true,
    });
    expect(fresh.replies).toBe(old.replies);
  });
});

describe("interruption counting (slack-review-queue.ts:77-85)", () => {
  it.each([0, 1, 2, 3, 4])("a stale running job with %s prior interruptions", async (k) => {
    const sc: Scenario = {
      start: { state: "running", interruptions: k },
      ship: ["defer", "defer"],
      react: "ok",
    };
    const old = await runOld(sc);
    const job = aReviewJobInState("running", {
      interruptions: k,
      leaseUntil: new Date(NOW.getTime() - 1),
    });
    const r = transition(job, { type: "lease_expired" }, NOW);
    const limitHit = k + 1 >= 3;
    expect(old.state === "failed").toBe(limitHit);
    expect(r.ok && r.value.state === "failed").toBe(limitHit);
    if (limitHit) {
      expect(old.interruptions).toBe(k + 1);
      expect(r.ok && r.value.interruptions).toBe(k + 1);
    }
  });
});

describe("runnable() eligibility", () => {
  const cases: [string, { state: ReviewJobState }, boolean][] = [
    ["queued", { state: "queued" }, true],
    ["running (stale)", { state: "running" }, true],
    ["done", { state: "done" }, false],
    ["failed", { state: "failed" }, false],
  ];
  it.each(cases)("%s", async (_n, start, runnable) => {
    const q = new OneJobQueue(oldJob(start as Start, URLS));
    const old = await processSlackReviewJob(q.asQueue(), "j", {
      ship: async () => {},
      react: async () => {},
    });
    expect(old).toBe(runnable);
    const s = start.state;
    const job = aReviewJobInState(s, {
      leaseUntil: s === "running" ? new Date(NOW.getTime() - 1) : null,
    });
    const event: ReviewJobEvent =
      s === "running" ? { type: "lease_expired" } : { type: "claimed", owner: "w", leaseMs: 1000 };
    expect(transition(job, event, NOW).ok).toBe(runnable);
  });

  it("DEVIATION D5: a queued job with a future nextAttemptAt runs today but waits in the new machine", async () => {
    const q = new OneJobQueue(oldJob({ state: "queued", dueIn: 60_000 }, []));
    expect(
      await processSlackReviewJob(q.asQueue(), "j", {
        ship: async () => {},
        react: async () => {},
      }),
    ).toBe(true);
    const job = aReviewJobInState("queued", { nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    expect(transition(job, { type: "claimed", owner: "w", leaseMs: 1000 }, NOW).ok).toBe(false);
  });
});

describe("retryFailedSlackReviewJobs", () => {
  it("clears error / schedule / interruptions and keeps checkpoints, like `retry`", async () => {
    const failed: SlackReviewJob = {
      ...oldJob({ state: "queued", interruptions: 3 }, [URLS[0]!]),
      status: "failed",
      error: "boom",
      nextAttemptAt: 5,
    };
    let saved: SlackReviewJob | undefined;
    const queue = {
      recent: async () => [failed],
      save: async (j: SlackReviewJob) => {
        saved = structuredClone(j);
      },
    } as unknown as SlackReviewQueue;
    expect(await retryFailedSlackReviewJobs(queue)).toBe(1);

    const job = aReviewJobInState("failed", {
      urls: URLS,
      interruptions: 3,
      progress: { [URLS[0]!]: { completed: true } },
    });
    const r = transition(job, { type: "retry" }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(saved?.status).toBe(r.value.state);
    expect(saved?.error).toBeUndefined();
    expect(r.value.lastError).toBeUndefined();
    expect(saved?.interruptions).toBeUndefined();
    expect(r.value.interruptions).toBeUndefined();
    expect(saved?.progress[URLS[0]!]).toEqual({ completed: true });
    expect(r.value.progress[URLS[0]!]).toEqual({ completed: true });
  });

  it("DEVIATION D3: today the reply flag survives a retry, the new machine clears it", async () => {
    const failed: SlackReviewJob = {
      ...oldJob({ state: "queued" }, []),
      status: "failed",
      resultReplySent: true,
    };
    let saved: SlackReviewJob | undefined;
    const queue = {
      recent: async () => [failed],
      save: async (j: SlackReviewJob) => {
        saved = structuredClone(j);
      },
    } as unknown as SlackReviewQueue;
    await retryFailedSlackReviewJobs(queue);
    expect(saved?.resultReplySent).toBe(true);
    const r = transition(
      aReviewJobInState("failed", { resultReplySent: true }),
      { type: "retry" },
      NOW,
    );
    expect(r.ok && r.value.resultReplySent).toBeUndefined();
  });
});
