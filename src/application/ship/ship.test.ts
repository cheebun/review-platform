import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ok } from "../../domain/shared/result";
import type { Actor } from "../../domain/shared/actor";
import { REFUSAL } from "../../domain/ship/policy";
import { CHANGES, FORCE_APPROVED, MERGED } from "../../domain/slack/status-emoji";
import { FakeGitHub } from "../../testing/fakes/fake-github";
import { blocking, CHANNEL, harness, PR1, SHA_A, SHA_B, TS } from "../review/harness.test-support";
import { processNextReviewJob } from "../review/review-job-consumer";
import { MERGEABLE_MAX_READS } from "../../ports/github";
import {
  approvePr,
  forceApprovePr,
  mergeChecklist,
  mergePr,
  SHIP_REFUSAL,
  type ShipDeps,
} from "./ship";

const OWNER: Actor = { kind: "user", userId: "user-1", email: "owner@example.com" };
const MACHINE: Actor = { kind: "machine", name: "machine" };
const ref1 = { owner: "acme", repo: "app", number: 1 };
const req = (actor: Actor = OWNER) => ({ actor, prUrl: PR1, source: "slack" as const });

/** Marks every due reaction op done, as a drainer whose Slack calls all succeed would. */
async function settle(h: ReturnType<typeof harness>) {
  for (let i = 0; i < 20; i++) {
    const due = await h.outbox.claimDue({ owner: "settle", leaseMs: 1000, limit: 50 });
    if (due.length === 0) return;
    for (const op of due) await h.outbox.markDone(op.id, "settle");
  }
}

/** A reviewed PR: the consumer ran (auto-approve off unless `autoApprove`), then ship deps. */
async function reviewed(opts: { verdict?: "pass" | "red"; autoApprove?: boolean } = {}) {
  const h = harness();
  if (opts.verdict === "red") h.reviewer.answers = [ok(blocking())];
  if (!opts.autoApprove) h.setRepos([]);
  await h.enqueue();
  await processNextReviewJob(h.deps, "worker");
  h.setRepos(["acme/app"]);
  await settle(h);
  const ship: ShipDeps = {
    github: h.github,
    records: h.records,
    events: h.events,
    jobs: h.jobs,
    threads: h.threads,
    uow: h.uow,
    repoList: async () => ["acme/app"],
    clock: h.clock,
    ids: h.ids,
    logger: h.logger,
    timers: h.timers,
  };
  const approvals = () => h.reviews().filter((r) => r.state === "APPROVED");
  const types = async () => (await h.events.list({ prUrl: PR1, limit: 50 })).map((e) => e.type);
  const pendingEmoji = async () =>
    (await h.outbox.listForMessage(CHANNEL, TS))
      .filter((o) => o.state === "pending")
      .map((o) => `${o.op}:${o.emoji}`);
  return { h, ship, approvals, types, pendingEmoji };
}

describe("approvePr", () => {
  it("approves at the reviewed head and records the user's approval", async () => {
    const t = await reviewed();
    expect(t.approvals()).toEqual([]);
    const out = await approvePr(t.ship, req());
    expect(out).toEqual(ok({ status: "approved", sha: SHA_A, githubReviewId: expect.any(Number) }));
    expect(t.approvals().map((r) => r.commitId)).toEqual([SHA_A]);
    const approved = (await t.h.events.list({ prUrl: PR1, types: ["approved"], limit: 5 }))[0]!;
    expect(approved).toMatchObject({
      actor: { kind: "user", id: "user-1" },
      sha: SHA_A,
      source: "slack",
    });
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("refuses after a red review and points to force approve", async () => {
    const t = await reviewed({ verdict: "red" });
    const out = await approvePr(t.ship, req());
    expect(out).toEqual({
      ok: false,
      error: { kind: "conflict", reason: REFUSAL.changesRequested },
    });
    expect(t.approvals()).toEqual([]);
  });

  it("refuses when the head moved since the review", async () => {
    const t = await reviewed();
    t.h.world.pushHead(ref1, SHA_B);
    const out = await approvePr(t.ship, req());
    expect(out).toEqual({ ok: false, error: { kind: "conflict", reason: REFUSAL.staleReview } });
    expect(t.approvals()).toEqual([]);
  });

  it("already approved on GitHub by hand: no second APPROVE, the approval is recorded once", async () => {
    const t = await reviewed();
    t.h.world.addReview(ref1, { state: "APPROVED", commitId: SHA_A });
    expect(await approvePr(t.ship, req())).toMatchObject({ value: { status: "already_approved" } });
    expect(await approvePr(t.ship, req())).toMatchObject({ value: { status: "already_approved" } });
    expect(t.approvals()).toHaveLength(1);
    expect((await t.types()).filter((x) => x === "approved")).toHaveLength(1);
  });

  it("machine actors cannot approve", async () => {
    const t = await reviewed();
    expect(await approvePr(t.ship, req(MACHINE))).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
    expect(t.approvals()).toEqual([]);
  });

  it("a failed APPROVE is recorded as approve_failed and returned", async () => {
    const t = await reviewed();
    t.h.github.beforeSubmit = () => ({
      ok: false,
      error: { kind: "upstream", service: "github", retryable: true },
    });
    expect(await approvePr(t.ship, req())).toMatchObject({
      ok: false,
      error: { kind: "upstream" },
    });
    expect(await t.types()).toContain("approve_failed");
  });
});

describe("forceApprovePr", () => {
  it("approves a red PR at the head and swaps 🔴 for 🟡 in the same transaction", async () => {
    const t = await reviewed({ verdict: "red" });
    const out = await forceApprovePr(t.ship, req());
    expect(out).toMatchObject({
      ok: true,
      value: { status: "force_approved", sha: SHA_A, overridden: "changes_requested" },
    });
    expect(t.approvals().map((r) => r.commitId)).toEqual([SHA_A]);
    const forced = (await t.h.events.list({ prUrl: PR1, types: ["force_approved"], limit: 5 }))[0]!;
    expect(forced).toMatchObject({ actor: { kind: "user", id: "user-1" }, sha: SHA_A });
    expect(await t.pendingEmoji()).toEqual([`remove:${CHANGES}`, `add:${FORCE_APPROVED}`]);
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("reuses an APPROVED review already at the head (retry after a crash)", async () => {
    const t = await reviewed({ verdict: "red" });
    t.h.world.addReview(ref1, { state: "APPROVED", commitId: SHA_A });
    await forceApprovePr(t.ship, req());
    expect(t.approvals()).toHaveLength(1);
  });

  it("a second force approve is a no-op", async () => {
    const t = await reviewed({ verdict: "red" });
    await forceApprovePr(t.ship, req());
    expect(await forceApprovePr(t.ship, req())).toMatchObject({
      value: { status: "already_force_approved" },
    });
    expect(t.approvals()).toHaveLength(1);
  });

  it("no 🟡 on a thread that carries several PRs", async () => {
    const t = await reviewed({ verdict: "red" });
    await t.h.threads.recordReview({
      channel: CHANNEL,
      threadTs: TS,
      prUrls: ["https://github.com/acme/app/pull/2"],
      requesterSlackId: "U0ALICE",
      reviewId: "other",
    });
    await forceApprovePr(t.ship, req());
    expect(await t.pendingEmoji()).toEqual([]);
  });
});

describe("mergePr", () => {
  it("refuses without an approval and returns the checklist", async () => {
    const t = await reviewed();
    const out = await mergePr(t.ship, req());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error).toEqual({ kind: "conflict", reason: REFUSAL.notApproved });
    expect(out.error.gates.find((g) => g.id === "approved_at_sha")).toEqual({
      id: "approved_at_sha",
      status: "fail",
    });
    expect(out.error.gates.find((g) => g.id === "no_p0")).toEqual({ id: "no_p0", status: "pass" });
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("merges an auto-approved green PR pinned to the head and queues ✅ next to 🟢", async () => {
    const t = await reviewed({ autoApprove: true });
    const out = await mergePr(t.ship, req());
    expect(out).toMatchObject({
      ok: true,
      value: { status: "merged", sha: SHA_A, p0Waived: false },
    });
    expect(t.h.world.getPr(ref1)!.merged).toBe(true);
    expect(await t.types()).toContain("merged");
    expect(await t.pendingEmoji()).toEqual([`add:${MERGED}`]);
  });

  it("after force approve the P0 gate is waived and ✅ sits next to 🟡", async () => {
    const t = await reviewed({ verdict: "red" });
    await forceApprovePr(t.ship, req());
    const out = await mergePr(t.ship, req());
    expect(out).toMatchObject({ ok: true, value: { p0Waived: true } });
    if (!out.ok || out.value.status !== "merged") return;
    expect(out.value.gates.find((g) => g.id === "no_p0")!.status).toBe("waived");
    await settle(t.h);
    expect((await t.h.outbox.currentReactions(CHANNEL, TS)).toSorted()).toEqual(
      [FORCE_APPROVED, MERGED].toSorted(),
    );
  });

  it("refuses when required checks are not green", async () => {
    const t = await reviewed({ autoApprove: true });
    t.h.world.addCheckRun({ owner: "acme", repo: "app" }, SHA_A, {
      name: "ci",
      conclusion: "failure",
    });
    const out = await mergePr(t.ship, req());
    expect(out).toMatchObject({ ok: false, error: { error: { reason: REFUSAL.checksNotGreen } } });
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("refuses when the head moved after the approval", async () => {
    const t = await reviewed({ autoApprove: true });
    t.h.world.pushHead(ref1, SHA_B);
    const out = await mergePr(t.ship, req());
    expect(out).toMatchObject({ ok: false, error: { error: { reason: REFUSAL.staleApproval } } });
  });

  it("machine actors cannot merge", async () => {
    const t = await reviewed({ autoApprove: true });
    expect(await mergePr(t.ship, req(MACHINE))).toMatchObject({
      ok: false,
      error: { error: { kind: "forbidden" } },
    });
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("a GitHub merge failure is recorded and returned with the checklist; no ✅", async () => {
    const t = await reviewed({ autoApprove: true });
    t.h.world.setMergeSettings(
      { owner: "acme", repo: "app" },
      { merge: false, squash: false, rebase: false },
    );
    const out = await mergePr(t.ship, req());
    expect(out).toMatchObject({ ok: false, error: { error: { kind: "conflict" } } });
    expect(await t.types()).toContain("merge_failed");
    expect(await t.pendingEmoji()).toEqual([]);
  });

  it("uses the configured merge method", async () => {
    const t = await reviewed({ autoApprove: true });
    t.ship.github = new FakeGitHub(t.h.world, { mergeMethods: ["merge", "squash"] });
    t.ship.mergeMethod = "squash";
    await mergePr(t.ship, req());
    expect(t.h.world.getPr(ref1)!.mergeMethod).toBe("squash");
  });

  it("an already merged PR is reported, not merged again", async () => {
    const t = await reviewed({ autoApprove: true });
    await mergePr(t.ship, req());
    expect(await mergePr(t.ship, req())).toEqual(ok({ status: "already_merged" }));
    expect(t.h.world.count("merge")).toBe(1);
  });

  it("property: a merge only ever happens at the head, after an approval at that head", async () => {
    const action = fc.constantFrom("approve", "force", "push", "merge", "check_fail");
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.array(action, { maxLength: 6 }), async (green, actions) => {
        const t = await reviewed(green ? {} : { verdict: "red" });
        let head = SHA_A;
        for (const a of actions) {
          if (a === "approve") await approvePr(t.ship, req());
          if (a === "force") await forceApprovePr(t.ship, req());
          if (a === "push" && !t.h.world.getPr(ref1)!.merged) {
            head = head === SHA_A ? SHA_B : SHA_A;
            t.h.world.pushHead(ref1, head);
          }
          if (a === "check_fail") {
            t.h.world.addCheckRun({ owner: "acme", repo: "app" }, head, {
              name: "ci",
              conclusion: "failure",
            });
          }
          if (a === "merge") {
            const approvedAtHead = t.approvals().some((r) => r.commitId === head);
            const out = await mergePr(t.ship, req());
            if (out.ok && out.value.status === "merged") {
              expect(out.value.sha).toBe(head);
              expect(approvedAtHead).toBe(true);
            }
          }
        }
        for (const r of t.approvals()) expect([SHA_A, SHA_B]).toContain(r.commitId);
      }),
      { numRuns: 60 },
    );
  });
});

describe("mergePr: GitHub mergeable signal", () => {
  it("refuses a PR GitHub reports as not mergeable; 0 merge calls", async () => {
    const t = await reviewed({ autoApprove: true });
    const pr = t.h.world.getPr(ref1)!;
    pr.mergeable = false;
    pr.mergeableState = "dirty";
    const out = await mergePr(t.ship, req());
    expect(out).toMatchObject({
      ok: false,
      error: { error: { kind: "conflict", reason: REFUSAL.notMergeable } },
    });
    if (out.ok) return;
    expect(out.error.gates.find((g) => g.id === "mergeable")).toEqual({
      id: "mergeable",
      status: "fail",
    });
    expect(out.error.unknown ?? []).not.toContain("mergeable");
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("still computing after the bounded re-reads: a failing gate with its own reason, never a pass", async () => {
    const t = await reviewed({ autoApprove: true });
    t.h.world.setMergeableComputing(ref1, 100);
    const before = t.h.world.count("pr_read");
    const out = await mergePr(t.ship, req());
    expect(out).toMatchObject({
      ok: false,
      error: { error: { kind: "conflict", reason: SHIP_REFUSAL.mergeableUnknown } },
    });
    if (out.ok) return;
    expect(out.error.gates.find((g) => g.id === "mergeable")!.status).toBe("fail");
    expect(out.error.unknown).toContain("mergeable");
    expect(t.h.world.count("pr_read") - before).toBe(MERGEABLE_MAX_READS);
    expect(t.h.world.count("merge")).toBe(0);
  });

  it("waits for GitHub to finish computing, then merges", async () => {
    const t = await reviewed({ autoApprove: true });
    t.h.world.setMergeableComputing(ref1, 2);
    expect(await mergePr(t.ship, req())).toMatchObject({ ok: true, value: { status: "merged" } });
  });

  it("an earlier gate's reason wins over an unknown mergeable", async () => {
    const t = await reviewed();
    t.h.world.setMergeableComputing(ref1, 100);
    expect(await mergePr(t.ship, req())).toMatchObject({
      ok: false,
      error: { error: { reason: REFUSAL.notApproved } },
    });
  });
});

describe("mergePr: expected head SHA (page pinning)", () => {
  it("merges when the head is the one the page showed", async () => {
    const t = await reviewed({ autoApprove: true });
    expect(await mergePr(t.ship, { ...req(), expectedSha: SHA_A.toUpperCase() })).toMatchObject({
      ok: true,
      value: { status: "merged", sha: SHA_A },
    });
  });

  it("refuses with headMoved, before any write, when the head moved since page load", async () => {
    const t = await reviewed({ autoApprove: true });
    const out = await mergePr(t.ship, { ...req(), expectedSha: SHA_B });
    expect(out).toMatchObject({
      ok: false,
      error: { error: { kind: "conflict", reason: SHIP_REFUSAL.headMoved } },
    });
    expect(t.h.world.count("merge")).toBe(0);
    expect(await t.types()).not.toContain("merge_failed");
  });
});

describe("mergeChecklist", () => {
  it("reports every gate at the live head, and canMerge, without writing anything", async () => {
    const t = await reviewed({ autoApprove: true });
    const eventsBefore = (await t.types()).length;
    const submitsBefore = t.h.world.count("submitReview");
    const out = await mergeChecklist(t.ship, { actor: OWNER, prUrl: PR1 });
    expect(out).toMatchObject({
      ok: true,
      value: {
        prUrl: PR1,
        headSha: SHA_A,
        state: "open",
        canMerge: true,
        blocked: null,
        mergeable: true,
        mergeableState: "clean",
        unknown: [],
        p0Waived: false,
      },
    });
    if (!out.ok) return;
    expect(out.value.gates.every((g) => g.status === "pass")).toBe(true);
    expect(t.h.world.count("merge")).toBe(0);
    expect(t.h.world.count("submitReview")).toBe(submitsBefore);
    expect((await t.types()).length).toBe(eventsBefore);
  });

  it("an unreadable checks lookup and an uncomputed mergeable are unknown, and block", async () => {
    const t = await reviewed({ autoApprove: true });
    t.h.world.setMergeableComputing(ref1, 100);
    t.ship.github = Object.assign(Object.create(t.h.github), {
      getChecks: async () => ({
        ok: false as const,
        error: { kind: "upstream" as const, service: "github" as const, retryable: true },
      }),
    });
    const out = await mergeChecklist(t.ship, { actor: OWNER, prUrl: PR1 });
    expect(out).toMatchObject({ ok: true, value: { canMerge: false, checks: null } });
    if (!out.ok) return;
    expect(out.value.unknown.toSorted()).toEqual(["checks_green", "mergeable"]);
    expect(out.value.blocked).toMatchObject({ kind: "upstream" });
  });

  it("a machine actor can see the checklist but can never merge", async () => {
    const t = await reviewed({ autoApprove: true });
    const out = await mergeChecklist(t.ship, { actor: MACHINE, prUrl: PR1 });
    expect(out).toMatchObject({
      ok: true,
      value: { canMerge: false, blocked: { kind: "forbidden" } },
    });
  });

  it("a merged PR is reported as merged with no merge possible", async () => {
    const t = await reviewed({ autoApprove: true });
    await mergePr(t.ship, req());
    expect(await mergeChecklist(t.ship, { actor: OWNER, prUrl: PR1 })).toMatchObject({
      ok: true,
      value: { state: "merged", canMerge: false },
    });
  });
});
