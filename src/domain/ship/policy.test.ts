import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AiReviewResult, Finding, Severity } from "../review/types";
import {
  REFUSAL,
  approvePlan,
  autoApprovePlan,
  forceApprovePlan,
  isRepoAllowed,
  mergeDecision,
  mergeGates,
  mergePlan,
  type ApprovalRecord,
  type ApproveInput,
  type AutoApproveInput,
  type ForceApproveInput,
  type MergeGateId,
  type MergeInput,
  type PolicyActor,
  type PrState,
  type RepoRef,
  type ReviewAtSha,
} from "./policy";

const SHA = "a".repeat(40);
const OLD = "c".repeat(40);
const user: PolicyActor = { kind: "user", userId: "u1", email: "u@x.dev" };
const machine: PolicyActor = { kind: "machine", name: "machine" };
const system: PolicyActor = { kind: "system" };
const REPO: RepoRef = { owner: "acme", repo: "web" };
const ALLOW = ["acme/web"];
const LOGIN = "reviewer";

const openPr: PrState = {
  open: true,
  draft: false,
  merged: false,
  author: "alice",
  headSha: SHA,
  baseSha: "b".repeat(40),
};
const pass = (sha = SHA): ReviewAtSha => ({ sha, verdict: "pass" });
const red = (sha = SHA): ReviewAtSha => ({ sha, verdict: "changes_requested" });
const approved = (sha = SHA): ApprovalRecord => ({ kind: "approved", sha });
const forced = (sha = SHA): ApprovalRecord => ({ kind: "force_approved", sha });

const kind = (r: { ok: boolean; error?: { kind: string } }) => (r.ok ? "ok" : r.error?.kind);
const reason = (r: { ok: boolean; error?: unknown }) =>
  r.ok ? undefined : (r.error as { reason?: string; message?: string }).reason;

const finding = (severity: Severity): Finding => ({ severity, title: "t", body: "b" });
const review = (...sev: Severity[]): AiReviewResult => ({
  summary: "s",
  findings: sev.map(finding),
  verificationRequests: ["v"],
});

// ---------------------------------------------------------------------------
// Allowlist (S2) hardening, kept from the previous policy
// ---------------------------------------------------------------------------

describe("isRepoAllowed (S2, fail closed)", () => {
  it("matches case-insensitively on the exact owner/repo", () => {
    expect(isRepoAllowed(REPO, ["Acme/Web"])).toBe(true);
    expect(isRepoAllowed(REPO, [" acme/web "])).toBe(true);
    expect(isRepoAllowed(REPO, ["other/x", "acme/web"])).toBe(true);
  });
  it.each([
    ["*"],
    ["acme/*"],
    ["*/web"],
    ["acme"],
    ["acme/we"],
    ["acme/web/x"],
    [""],
    [" "],
    ["/"],
  ])("rejects the malformed or non-matching entry %j", (entry) => {
    expect(isRepoAllowed(REPO, [entry])).toBe(false);
  });
  it("an empty or missing list denies everything", () => {
    expect(isRepoAllowed(REPO, [])).toBe(false);
    expect(isRepoAllowed(REPO, undefined)).toBe(false);
    expect(isRepoAllowed(REPO, null as never)).toBe(false);
  });
  it("a slash smuggled into owner or repo cannot match a joined entry", () => {
    expect(isRepoAllowed({ owner: "acme/web", repo: "x" }, ["acme/web/x"])).toBe(false);
    expect(isRepoAllowed({ owner: "acme", repo: "web/x" }, ["acme/web/x", "acme/web"])).toBe(false);
  });
  it("non-string parts and entries are rejected", () => {
    expect(isRepoAllowed({ owner: 1, repo: "web" } as never, ALLOW)).toBe(false);
    expect(isRepoAllowed(undefined as never, ALLOW)).toBe(false);
    expect(isRepoAllowed(REPO, [42 as never])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeDecision: pure verdict
// ---------------------------------------------------------------------------

describe("mergeDecision (verdict only)", () => {
  it.each<[Severity[], string, string, number]>([
    [[], "pass", "APPROVE", 0],
    [["P1"], "pass", "APPROVE", 0],
    [["P2", "Nit"], "pass", "APPROVE", 0],
    [["P1", "P2", "Nit"], "pass", "APPROVE", 0],
    [["P0"], "changes_requested", "REQUEST_CHANGES", 1],
    [["P0", "Nit", "P0"], "changes_requested", "REQUEST_CHANGES", 2],
    [["p0" as Severity], "changes_requested", "REQUEST_CHANGES", 1],
    [["P1", "weird" as Severity], "changes_requested", "REQUEST_CHANGES", 1],
  ])("%j -> %s", (sev, verdict, event, blockingCount) => {
    expect(mergeDecision(review(...sev))).toEqual({
      ok: true,
      value: { verdict, event, blockingCount },
    });
  });
  it("an unreadable review is never a pass", () => {
    for (const bad of [undefined, null, {}, { findings: "x" }, { findings: [null] }]) {
      const r = mergeDecision(bad as never);
      expect(r.ok && r.value.verdict === "pass").toBe(false);
    }
    expect(kind(mergeDecision(undefined as never))).toBe("validation");
  });
  it("carries no merge or approve decision", () => {
    const r = mergeDecision(review());
    expect(r.ok && Object.keys(r.value).toSorted()).toEqual(["blockingCount", "event", "verdict"]);
  });
});

// ---------------------------------------------------------------------------
// autoApprovePlan
// ---------------------------------------------------------------------------

const auto = (over: Partial<AutoApproveInput> = {}): AutoApproveInput => ({
  actor: system,
  repo: REPO,
  allowlist: ALLOW,
  pr: openPr,
  authenticatedLogin: LOGIN,
  reviewedSha: SHA,
  verdict: "pass",
  approvals: [],
  ...over,
});

describe("autoApprovePlan", () => {
  it("approves at the reviewed SHA for the system actor on a pass", () => {
    expect(autoApprovePlan(auto())).toEqual({ ok: true, value: { kind: "approve", sha: SHA } });
  });
  it("matches the head SHA case-insensitively", () => {
    const r = autoApprovePlan(auto({ reviewedSha: SHA.toUpperCase() }));
    expect(r).toEqual({ ok: true, value: { kind: "approve", sha: SHA } });
  });

  it.each<[string, Partial<AutoApproveInput>, string]>([
    ["verdict changes_requested", { verdict: "changes_requested" }, "not_passed"],
    ["unknown verdict", { verdict: "maybe" as never }, "not_passed"],
    ["repo not in the list", { allowlist: ["other/x"] }, "repo_not_allowed"],
    ["empty list", { allowlist: [] }, "repo_not_allowed"],
    ["merged PR", { pr: { ...openPr, open: false, merged: true } }, "pr_merged"],
    ["closed PR", { pr: { ...openPr, open: false } }, "pr_closed"],
    ["draft PR", { pr: { ...openPr, draft: true } }, "pr_draft"],
    ["own PR", { pr: { ...openPr, author: "REVIEWER" } }, "own_pr"],
    [
      "own PR (padded login)",
      { authenticatedLogin: " reviewer ", pr: { ...openPr, author: "reviewer" } },
      "own_pr",
    ],
    ["SHA changed", { reviewedSha: OLD }, "sha_changed"],
    ["already approved at SHA", { approvals: [approved()] }, "already_approved"],
    ["already force-approved at SHA", { approvals: [forced()] }, "already_approved"],
    ["already approved on GitHub", { githubApprovedAtHead: true }, "already_approved"],
  ])("%s -> skip(%s)", (_name, over, why) => {
    expect(autoApprovePlan(auto(over))).toEqual({ ok: true, value: { kind: "skip", reason: why } });
  });

  it("an approval at another SHA does not make it a no-op", () => {
    expect(autoApprovePlan(auto({ approvals: [approved(OLD)] }))).toEqual({
      ok: true,
      value: { kind: "approve", sha: SHA },
    });
  });

  it("only the system actor may auto-approve", () => {
    expect(kind(autoApprovePlan(auto({ actor: user })))).toBe("forbidden");
    expect(kind(autoApprovePlan(auto({ actor: machine })))).toBe("forbidden");
    expect(kind(autoApprovePlan(auto({ actor: { kind: "bot" } as never })))).toBe("forbidden");
  });

  it("malformed SHAs and an unknown login fail closed", () => {
    expect(kind(autoApprovePlan(auto({ pr: { ...openPr, headSha: "abc" } })))).toBe("validation");
    expect(kind(autoApprovePlan(auto({ reviewedSha: "z".repeat(40) })))).toBe("validation");
    expect(kind(autoApprovePlan(auto({ authenticatedLogin: "  " })))).toBe("validation");
    const sha64 = "e".repeat(64);
    expect(
      autoApprovePlan(auto({ reviewedSha: sha64, pr: { ...openPr, headSha: sha64 } })),
    ).toEqual({ ok: true, value: { kind: "approve", sha: sha64 } });
  });

  it("never throws on garbage input", () => {
    for (const g of [undefined, null, {}, { actor: system }]) {
      expect(() => autoApprovePlan(g as never)).not.toThrow();
      expect(kind(autoApprovePlan(g as never))).not.toBe("ok");
    }
  });
});

// ---------------------------------------------------------------------------
// approvePlan (owner `approve`, manual retry)
// ---------------------------------------------------------------------------

const appr = (over: Partial<ApproveInput> = {}): ApproveInput => ({
  actor: user,
  repo: REPO,
  allowlist: ALLOW,
  pr: openPr,
  authenticatedLogin: LOGIN,
  latestReview: pass(),
  approvals: [],
  ...over,
});

describe("approvePlan", () => {
  it("approves at the current head when the latest review at that SHA passed", () => {
    expect(approvePlan(appr())).toEqual({ ok: true, value: { kind: "approve", sha: SHA } });
  });

  it.each<[string, Partial<ApproveInput>, string, string]>([
    ["machine actor", { actor: machine }, "forbidden", REFUSAL.ownerOnly],
    ["system actor", { actor: system }, "forbidden", REFUSAL.ownerOnly],
    ["repo not in the list", { allowlist: [] }, "forbidden", REFUSAL.repoNotAllowed],
    ["merged", { pr: { ...openPr, open: false, merged: true } }, "conflict", REFUSAL.merged],
    ["closed", { pr: { ...openPr, open: false } }, "conflict", REFUSAL.closed],
    ["draft", { pr: { ...openPr, draft: true } }, "conflict", REFUSAL.draft],
    ["own PR", { pr: { ...openPr, author: "Reviewer" } }, "forbidden", REFUSAL.ownPr],
    ["no review on record", { latestReview: null }, "conflict", REFUSAL.noReview],
    ["SHA changed since review", { latestReview: pass(OLD) }, "conflict", REFUSAL.staleReview],
    ["latest review is red", { latestReview: red() }, "conflict", REFUSAL.changesRequested],
  ])("%s -> %s", (_name, over, k, why) => {
    const r = approvePlan(appr(over));
    expect(kind(r)).toBe(k);
    expect(reason(r)).toBe(why);
  });

  it("the red refusal points to force approve; the stale refusal asks for a re-review", () => {
    expect(REFUSAL.changesRequested).toMatch(/force approve/);
    expect(REFUSAL.staleReview).toMatch(/re-review/);
  });

  it.each<[string, Partial<ApproveInput>]>([
    ["approved at SHA", { approvals: [approved()] }],
    ["force-approved at SHA (latest review red)", { approvals: [forced()], latestReview: red() }],
    ["approved on GitHub", { githubApprovedAtHead: true }],
  ])("already %s -> noop", (_name, over) => {
    expect(approvePlan(appr(over))).toEqual({
      ok: true,
      value: { kind: "noop", reason: "already_approved", sha: SHA },
    });
  });

  it("an approval at an older SHA is not a no-op and still needs a review at the head", () => {
    expect(kind(approvePlan(appr({ approvals: [approved(OLD)], latestReview: pass(OLD) })))).toBe(
      "conflict",
    );
  });

  it("malformed input fails closed", () => {
    expect(kind(approvePlan(appr({ pr: { ...openPr, headSha: "" } })))).toBe("validation");
    expect(kind(approvePlan(appr({ authenticatedLogin: "" })))).toBe("validation");
    expect(kind(approvePlan(appr({ latestReview: { sha: "x", verdict: "pass" } })))).toBe(
      "conflict",
    );
    expect(() => approvePlan(undefined as never)).not.toThrow();
    expect(kind(approvePlan(null as never))).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// forceApprovePlan (owner `force approve`, approve only)
// ---------------------------------------------------------------------------

const force = (over: Partial<ForceApproveInput> = {}): ForceApproveInput => ({
  actor: user,
  repo: REPO,
  allowlist: ALLOW,
  pr: openPr,
  authenticatedLogin: LOGIN,
  latestReview: red(),
  approvals: [],
  ...over,
});

describe("forceApprovePlan", () => {
  it("is always approve_only at the current head, carrying the overridden verdict", () => {
    expect(forceApprovePlan(force())).toEqual({
      ok: true,
      value: { kind: "approve_only", sha: SHA, overridden: "changes_requested" },
    });
  });

  it("overrides a red verdict even when an older normal approval exists at this SHA", () => {
    const r = forceApprovePlan(force({ approvals: [approved()] }));
    expect(r.ok && r.value.kind).toBe("approve_only");
  });

  it.each<[string, Partial<ForceApproveInput>, string, string]>([
    ["machine actor", { actor: machine }, "forbidden", REFUSAL.ownerOnly],
    ["system actor", { actor: system }, "forbidden", REFUSAL.ownerOnly],
    ["repo not in the list", { allowlist: ["acme/other"] }, "forbidden", REFUSAL.repoNotAllowed],
    ["merged", { pr: { ...openPr, open: false, merged: true } }, "conflict", REFUSAL.merged],
    ["closed", { pr: { ...openPr, open: false } }, "conflict", REFUSAL.closed],
    ["draft", { pr: { ...openPr, draft: true } }, "conflict", REFUSAL.draft],
    ["own PR", { pr: { ...openPr, author: "reviewer" } }, "forbidden", REFUSAL.ownPr],
    ["no review on record", { latestReview: null }, "conflict", REFUSAL.noReview],
    ["SHA changed since review", { latestReview: red(OLD) }, "conflict", REFUSAL.staleReview],
  ])("%s -> %s", (_name, over, k, why) => {
    const r = forceApprovePlan(force(over));
    expect(kind(r)).toBe(k);
    expect(reason(r)).toBe(why);
  });

  it("latest review already passing -> already approved by review", () => {
    expect(forceApprovePlan(force({ latestReview: pass() }))).toEqual({
      ok: true,
      value: { kind: "noop", reason: "already_approved_by_review", sha: SHA },
    });
  });

  it("already force-approved at this SHA -> noop; at another SHA it does not count", () => {
    expect(forceApprovePlan(force({ approvals: [forced()] }))).toEqual({
      ok: true,
      value: { kind: "noop", reason: "already_force_approved", sha: SHA },
    });
    const r = forceApprovePlan(force({ approvals: [forced(OLD)] }));
    expect(r.ok && r.value.kind).toBe("approve_only");
  });

  it("malformed input fails closed", () => {
    expect(kind(forceApprovePlan(force({ pr: { ...openPr, headSha: "abc" } })))).toBe("validation");
    expect(kind(forceApprovePlan(force({ authenticatedLogin: "" })))).toBe("validation");
    expect(() => forceApprovePlan({} as never)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mergeGates / mergePlan
// ---------------------------------------------------------------------------

const merge = (over: Partial<MergeInput> = {}): MergeInput => ({
  actor: user,
  repo: REPO,
  allowlist: ALLOW,
  pr: openPr,
  latestReview: pass(),
  approvals: [approved()],
  checksGreen: true,
  mergeable: true,
  ...over,
});
const GATE_ORDER: MergeGateId[] = [
  "allowlist",
  "open",
  "not_draft",
  "approved_at_sha",
  "no_p0",
  "checks_green",
  "mergeable",
];
const statusOf = (over: Partial<MergeInput>) =>
  Object.fromEntries(mergeGates(merge(over)).map((g) => [g.id, g.status]));

describe("mergeGates (the /merge checklist)", () => {
  it("lists every gate in a fixed order, all passing for a ready PR", () => {
    const gates = mergeGates(merge());
    expect(gates.map((g) => g.id)).toEqual(GATE_ORDER);
    expect(gates.every((g) => g.status === "pass")).toBe(true);
  });

  it.each<[string, Partial<MergeInput>, MergeGateId]>([
    ["repo not in the list", { allowlist: [] }, "allowlist"],
    ["closed", { pr: { ...openPr, open: false } }, "open"],
    ["merged", { pr: { ...openPr, merged: true } }, "open"],
    ["draft", { pr: { ...openPr, draft: true } }, "not_draft"],
    ["no approval", { approvals: [] }, "approved_at_sha"],
    ["approval at an older SHA", { approvals: [approved(OLD)] }, "approved_at_sha"],
    ["P0 at head", { latestReview: red() }, "no_p0"],
    ["no review at head", { latestReview: pass(OLD) }, "no_p0"],
    ["no review at all", { latestReview: null }, "no_p0"],
    ["checks red", { checksGreen: false }, "checks_green"],
    ["not mergeable", { mergeable: false }, "mergeable"],
    ["mergeability unknown", { mergeable: null }, "mergeable"],
  ])("%s fails only the %s gate", (_name, over, gate) => {
    const s = statusOf(over);
    for (const id of GATE_ORDER) expect(s[id]).toBe(id === gate ? "fail" : "pass");
  });

  it("a force approval at the head SHA waives the P0 gate; an older one does not", () => {
    expect(statusOf({ latestReview: red(), approvals: [forced()] }).no_p0).toBe("waived");
    expect(statusOf({ latestReview: red(), approvals: [forced(OLD), approved()] }).no_p0).toBe(
      "fail",
    );
  });

  it("never throws and fails every gate on garbage", () => {
    expect(() => mergeGates(undefined as never)).not.toThrow();
    const gates = mergeGates({} as never);
    expect(gates.map((g) => g.id)).toEqual(GATE_ORDER);
    expect(gates.every((g) => g.status === "fail")).toBe(true);
  });
});

describe("mergePlan", () => {
  it("merges at the current head with a normal approval and a passing review", () => {
    const r = mergePlan(merge());
    expect(r.ok && { ...r.value, gates: undefined }).toEqual({
      merge: true,
      sha: SHA,
      p0Waived: false,
      gates: undefined,
    });
    expect(r.ok && r.value.gates.map((g) => g.id)).toEqual(GATE_ORDER);
  });

  it("FR-SHIP-06 AC4: force approve at X with head X and a P0 on record merges, waived", () => {
    const r = mergePlan(merge({ latestReview: red(), approvals: [forced()] }));
    expect(r.ok && r.value.p0Waived).toBe(true);
  });

  it("FR-SHIP-06 AC4: force approve at X, head Y -> new commits since force approve", () => {
    const r = mergePlan(merge({ latestReview: red(OLD), approvals: [forced(OLD)] }));
    expect(kind(r)).toBe("conflict");
    expect(reason(r)).toBe(REFUSAL.staleForceApproval);
  });

  it.each<[string, Partial<MergeInput>, string, string]>([
    ["machine actor", { actor: machine }, "forbidden", REFUSAL.ownerOnly],
    ["system actor", { actor: system }, "forbidden", REFUSAL.ownerOnly],
    ["unknown actor", { actor: { kind: "bot" } as never }, "forbidden", REFUSAL.ownerOnly],
    ["repo not in the list", { allowlist: [] }, "forbidden", REFUSAL.repoNotAllowed],
    [
      "already merged",
      { pr: { ...openPr, open: false, merged: true } },
      "conflict",
      REFUSAL.merged,
    ],
    ["closed", { pr: { ...openPr, open: false } }, "conflict", REFUSAL.closed],
    ["draft", { pr: { ...openPr, draft: true } }, "conflict", REFUSAL.draft],
    ["no approval", { approvals: [] }, "conflict", REFUSAL.notApproved],
    ["approval at an older SHA", { approvals: [approved(OLD)] }, "conflict", REFUSAL.staleApproval],
    ["P0 at head", { latestReview: red() }, "conflict", REFUSAL.p0],
    ["no review at head", { latestReview: pass(OLD) }, "conflict", REFUSAL.staleReview],
    ["checks red", { checksGreen: false }, "conflict", REFUSAL.checksNotGreen],
    ["not mergeable", { mergeable: false }, "conflict", REFUSAL.notMergeable],
  ])("%s -> %s", (_name, over, k, why) => {
    const r = mergePlan(merge(over));
    expect(kind(r)).toBe(k);
    expect(reason(r)).toBe(why);
  });

  it("every merge refusal reason is distinct (FR-SHIP-05 AC1)", () => {
    const values = Object.values(REFUSAL);
    expect(values.length).toBeGreaterThanOrEqual(14);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((v) => typeof v === "string" && v.length > 0)).toBe(true);
  });

  it("a malformed head SHA fails closed, and garbage never throws", () => {
    expect(kind(mergePlan(merge({ pr: { ...openPr, headSha: "deadbeef" } })))).toBe("validation");
    expect(() => mergePlan(undefined as never)).not.toThrow();
    expect(kind(mergePlan(null as never))).toBe("validation");
  });

  it("a malformed approval SHA never counts", () => {
    const r = mergePlan(merge({ approvals: [{ kind: "approved", sha: "a".repeat(39) }] }));
    expect(reason(r)).toBe(REFUSAL.notApproved);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const arbHex = fc.oneof(fc.constantFrom(SHA, OLD), fc.stringMatching(/^[0-9a-f]{40}$/));
const arbSha = fc.oneof(arbHex, fc.string({ maxLength: 8 }));
const arbName = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
const arbPr: fc.Arbitrary<PrState> = fc.record({
  open: fc.boolean(),
  draft: fc.boolean(),
  merged: fc.boolean(),
  author: fc.oneof(fc.constantFrom("alice", LOGIN, LOGIN.toUpperCase()), arbName),
  headSha: arbSha,
  baseSha: arbSha,
});
const arbActor: fc.Arbitrary<PolicyActor> = fc.oneof(
  fc.constant(machine),
  fc.constant(system),
  fc.record({ kind: fc.constant("user" as const), userId: fc.string(), email: fc.string() }),
);
const arbEntry = fc.oneof(
  fc.constant("acme/web"),
  fc.tuple(arbName, arbName).map(([o, r]) => `${o}/${r}`),
  fc.constantFrom("*", "*/*", "acme/*", "", "/", "acme", "acme/web/x"),
);
const arbRepo: fc.Arbitrary<RepoRef> = fc.oneof(
  fc.constant(REPO),
  fc.record({ owner: arbName, repo: arbName }),
);
const arbVerdict = fc.constantFrom("pass" as const, "changes_requested" as const);
const arbReviewAt: fc.Arbitrary<ReviewAtSha | null> = fc.option(
  fc.record({ sha: arbSha, verdict: arbVerdict }),
);
const arbApprovals: fc.Arbitrary<ApprovalRecord[]> = fc.array(
  fc.record({ kind: fc.constantFrom("approved" as const, "force_approved" as const), sha: arbSha }),
  { maxLength: 4 },
);
const arbCtx = fc.record({
  actor: arbActor,
  repo: arbRepo,
  allowlist: fc.array(arbEntry, { maxLength: 4 }),
  pr: arbPr,
  authenticatedLogin: fc.oneof(fc.constant(LOGIN), arbName, fc.constant("")),
  latestReview: arbReviewAt,
  approvals: arbApprovals,
  reviewedSha: arbSha,
  verdict: arbVerdict,
  githubApprovedAtHead: fc.boolean(),
  checksGreen: fc.boolean(),
  mergeable: fc.constantFrom(true, false, null),
});
type Ctx = typeof arbCtx extends fc.Arbitrary<infer T> ? T : never;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const approvesOrMerges = (c: Ctx) => {
  const a = autoApprovePlan(c);
  const b = approvePlan(c);
  const f = forceApprovePlan(c);
  const m = mergePlan(c);
  return {
    auto: a.ok && a.value.kind === "approve",
    approve: b.ok && b.value.kind === "approve",
    force: f.ok && f.value.kind === "approve_only",
    merge: m.ok,
  };
};

describe("properties", () => {
  it("a system or machine actor can never merge or force approve", () => {
    fc.assert(
      fc.property(arbCtx, fc.constantFrom(system, machine), (c, actor) => {
        const r = approvesOrMerges({ ...c, actor });
        return !r.merge && !r.force && !r.approve;
      }),
      { numRuns: 2000 },
    );
  });

  it("only the system actor can auto-approve", () => {
    fc.assert(
      fc.property(arbCtx, (c) => c.actor.kind === "system" || !approvesOrMerges(c).auto),
      { numRuns: 1000 },
    );
  });

  it("any SHA mismatch means no approve and no merge", () => {
    fc.assert(
      fc.property(arbCtx, (c) => {
        const r = approvesOrMerges(c);
        const head = c.pr.headSha;
        const reviewAtHead = c.latestReview !== null && same(c.latestReview.sha, head);
        const approvalAtHead = c.approvals.some((a) => same(a.sha, head));
        if (!same(c.reviewedSha, head) && r.auto) return false;
        if (!reviewAtHead && (r.approve || r.force)) return false;
        if (!approvalAtHead && r.merge) return false;
        return true;
      }),
      { numRuns: 3000 },
    );
  });

  it("a merge without a passing review at head always has a force approval at head", () => {
    fc.assert(
      fc.property(arbCtx, (c) => {
        const m = mergePlan(c);
        if (!m.ok) return true;
        const passAtHead =
          c.latestReview !== null &&
          c.latestReview.verdict === "pass" &&
          same(c.latestReview.sha, c.pr.headSha);
        const forcedAtHead = c.approvals.some(
          (a) => a.kind === "force_approved" && same(a.sha, c.pr.headSha),
        );
        return (passAtHead || forcedAtHead) && m.value.p0Waived === !passAtHead;
      }),
      { numRuns: 3000 },
    );
  });

  it("mergePlan succeeds exactly when every gate passes or is waived and the actor is a user", () => {
    fc.assert(
      fc.property(arbCtx, (c) => {
        const allGood = mergeGates(c).every((g) => g.status !== "fail");
        const shaOk = /^[0-9a-f]{40}$/i.test(c.pr.headSha);
        return mergePlan(c).ok === (allGood && shaOk && c.actor.kind === "user");
      }),
      { numRuns: 3000 },
    );
  });

  it("an empty allowlist denies every approve and merge path", () => {
    fc.assert(
      fc.property(arbCtx, (c) => {
        const r = approvesOrMerges({ ...c, allowlist: [] });
        return !r.auto && !r.approve && !r.force && !r.merge;
      }),
      { numRuns: 1000 },
    );
  });

  it("closed, draft or merged PRs are never approved or merged", () => {
    fc.assert(
      fc.property(arbCtx, (c) => {
        if (c.pr.open && !c.pr.draft && !c.pr.merged) return true;
        const r = approvesOrMerges(c);
        return !r.auto && !r.approve && !r.force && !r.merge;
      }),
      { numRuns: 2000 },
    );
  });

  it("the connected account's own PR is never approved by any path", () => {
    fc.assert(
      fc.property(arbCtx, (c) => {
        const own = { ...c, pr: { ...c.pr, author: c.authenticatedLogin.toUpperCase() } };
        const r = approvesOrMerges(own);
        return !r.auto && !r.approve && !r.force;
      }),
      { numRuns: 1000 },
    );
  });

  it("every plan is pinned to the current head SHA", () => {
    fc.assert(
      fc.property(arbCtx, (c) => {
        const head = c.pr.headSha.toLowerCase();
        for (const r of [autoApprovePlan(c), approvePlan(c), forceApprovePlan(c), mergePlan(c)]) {
          if (r.ok && "sha" in r.value && r.value.sha !== head) return false;
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it("a P0 or unknown severity is never a pass", () => {
    const arbSev = fc.oneof(
      fc.constantFrom<Severity>("P0", "P1", "P2", "Nit"),
      fc.string() as fc.Arbitrary<Severity>,
    );
    fc.assert(
      fc.property(fc.array(arbSev), (sev) => {
        const r = mergeDecision(review(...sev));
        const blocked = sev.some((s) => !["P1", "P2", "Nit"].includes(s));
        return r.ok && (r.value.verdict === "pass") === !blocked;
      }),
      { numRuns: 1000 },
    );
  });
});
