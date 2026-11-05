import { applyPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrRef } from "../../domain/github/pr-ref";
import type { DomainError, Result } from "../../domain/shared/result";
import {
  ACCESSIBLE_REPOS_MAX_PAGES,
  ACCESSIBLE_REPOS_PAGE_SIZE,
  MERGEABLE_MAX_READS,
  type GitHubPort,
  type MergeMethod,
} from "../../ports/github";
import type { GithubWorld, WorldPr } from "../http/github/world";
import type { ContractHarness } from "./harness";

export type GitHubHarness = ContractHarness<GitHubPort> & { world: GithubWorld };

const NOW = new Date("2026-06-30T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const OWNER = "acme";
const REPO = "widgets";

const ref = (number: number): PrRef => ({
  owner: OWNER,
  repo: REPO,
  number,
  url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
});

function unwrap<T>(result: Result<T, DomainError>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

const errorOf = <T>(result: Result<T, DomainError>): DomainError => {
  if (result.ok) throw new Error("expected an error result");
  return result.error;
};

export function githubContract(make: () => Promise<GitHubHarness>) {
  describe("GitHubPort contract", () => {
    let h: GitHubHarness;
    let w: GithubWorld;
    beforeEach(async () => {
      h = await make();
      w = h.world;
    });
    afterEach(async () => {
      await h.cleanup();
    });

    const seed = (number: number, extra: Partial<WorldPr> = {}) =>
      w.addPr({ owner: OWNER, repo: REPO, number, ...extra });

    describe("listOpenPullRequests", () => {
      const list = (maxAgeDays = 15, authors: string[] = ["Author-A"]) =>
        h.impl.listOpenPullRequests(
          { owner: OWNER, repo: REPO },
          { authors, maxAgeDays, now: NOW },
        );

      it("keeps non-draft PRs by allowed authors (case-insensitive) with approval flag", async () => {
        const fresh = new Date(NOW.getTime() - DAY).toISOString();
        seed(1, { author: "author-a", updatedAt: fresh, title: "one", reviewDecision: "APPROVED" });
        seed(2, { author: "AUTHOR-A", updatedAt: fresh, reviewDecision: "REVIEW_REQUIRED" });
        seed(3, { author: "author-a", updatedAt: fresh, draft: true });
        seed(4, { author: "someone-else", updatedAt: fresh });
        const items = unwrap(await list());
        expect(items.map((i) => [i.number, i.approved])).toEqual([
          [1, true],
          [2, false],
        ]);
        expect(items[0]).toMatchObject({
          title: "one",
          author: "author-a",
          htmlUrl: `https://github.com/${OWNER}/${REPO}/pull/1`,
          base: "main",
          head: "branch-1",
          draft: false,
          updatedAt: fresh,
        });
      });

      it("maxAgeDays boundary: exactly at the cutoff is kept, 1 ms older is dropped", async () => {
        const cutoff = NOW.getTime() - 15 * DAY;
        seed(1, { author: "author-a", updatedAt: new Date(cutoff).toISOString() });
        seed(2, { author: "author-a", updatedAt: new Date(cutoff - 1000).toISOString() });
        expect(unwrap(await list(15)).map((i) => i.number)).toEqual([1]);
      });

      it("returns PRs most recently updated first and skips closed PRs", async () => {
        const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
        seed(1, { author: "author-a", updatedAt: at(3) });
        seed(2, { author: "author-a", updatedAt: at(1) });
        seed(3, { author: "author-a", updatedAt: at(2), state: "closed" });
        expect(unwrap(await list()).map((i) => i.number)).toEqual([2, 1]);
      });

      it("follows pagination across more than one page", async () => {
        const updatedAt = new Date(NOW.getTime() - DAY).toISOString();
        for (let n = 1; n <= 120; n++) seed(n, { author: "author-a", updatedAt });
        expect(unwrap(await list())).toHaveLength(120);
      });

      it("an empty repository yields an empty list", async () => {
        expect(unwrap(await list())).toEqual([]);
      });
    });

    describe("getPullRequest / getAuthenticatedLogin", () => {
      it("returns meta, head and base SHA, state, draft, merged and author", async () => {
        seed(5, {
          title: "T",
          body: "B",
          author: "author-a",
          headSha: "h1",
          baseSha: "b1",
          draft: true,
        });
        w.setFiles(ref(5), [{ filename: "a.ts", status: "modified", patch: "@@" }]);
        expect(unwrap(await h.impl.getPullRequest(ref(5)))).toEqual({
          title: "T",
          body: "B",
          author: "author-a",
          base: "main",
          head: "branch-5",
          sha: "h1",
          baseSha: "b1",
          state: "open",
          merged: false,
          draft: true,
          changedFiles: 1,
          htmlUrl: `https://github.com/${OWNER}/${REPO}/pull/5`,
          mergeable: true,
          mergeableState: "clean",
        });
      });

      it("a null/empty body becomes an empty string", async () => {
        seed(5, { body: "" });
        expect(unwrap(await h.impl.getPullRequest(ref(5))).body).toBe("");
      });

      it("reports a scripted head SHA change", async () => {
        seed(5, { headSha: "h1" });
        w.pushHead(ref(5), "h2");
        expect(unwrap(await h.impl.getPullRequest(ref(5))).sha).toBe("h2");
      });

      it("returns the authenticated login", async () => {
        w.login = "reviewer-bot";
        expect(unwrap(await h.impl.getAuthenticatedLogin())).toBe("reviewer-bot");
      });
    });

    describe("getDiff", () => {
      const patch = "@@ -1 +1 @@\n-old\n+new";

      it("keeps GitHub patches intact without extra recovery requests", async () => {
        seed(7, { baseSha: "base-tip-sha", headSha: "head-sha" });
        w.setFiles(ref(7), [
          { filename: "src/a.ts", status: "modified", patch, additions: 1, deletions: 1 },
        ]);
        const diff = unwrap(await h.impl.getDiff(ref(7)));
        expect(diff.complete).toBe(true);
        expect(diff.files).toEqual([{ header: "### src/a.ts (modified, +1/-1)", patch }]);
        expect(diff.meta.sha).toBe("head-sha");
        expect(w.count("blob")).toBe(0);
        expect(w.count("compare")).toBe(0);
      });

      it("verifies pure renames by blob SHA with a single merge-base lookup", async () => {
        seed(7);
        w.setFiles(ref(7), [
          {
            filename: "shared/a.ts",
            previous_filename: "renderer/a.ts",
            status: "renamed",
            before: "same",
            after: "same",
          },
          {
            filename: "shared/b.ts",
            previous_filename: "renderer/b.ts",
            status: "renamed",
            before: "also",
            after: "also",
          },
        ]);
        const diff = unwrap(await h.impl.getDiff(ref(7)));
        expect(diff.complete).toBe(true);
        expect(diff.files[0].header).toMatch(/Previous path: renderer\/a.ts/);
        expect(diff.files[0].patch).toMatch(
          /similarity index 100%\nrename from renderer\/a.ts\nrename to shared\/a.ts/,
        );
        expect(w.count("compare")).toBe(1);
        expect(w.count("blob")).toBe(0);
      });

      it("recovers a NUL-containing source without confusing it with a literal escape", async () => {
        const before = 'const key = [a, b].join("\0");\nconst other = "\0";\n';
        const after = 'const key = [a, b].join("\\0");\nconst other = "\\0";\n';
        seed(7);
        w.setFiles(ref(7), [{ filename: "src/Canvas.tsx", status: "modified", before, after }]);
        const diff = unwrap(await h.impl.getDiff(ref(7)));
        expect(diff.complete).toBe(true);
        expect(diff.files[0].header).toMatch(/Old file: 2 NUL bytes; new file: 0/);
        expect(diff.files[0].patch.includes("\0")).toBe(false);
        expect(diff.files[0].patch).toContain("⟦NUL:0x00⟧");
        expect(applyPatch(before, diff.files[0].patch.replaceAll("⟦NUL:0x00⟧", "\0"))).toBe(after);
      });

      it("zero line statistics do not hide edits inside a renamed file", async () => {
        const before = "export const a = 1;\n";
        const after = "export const a = 2;\n";
        seed(7);
        w.setFiles(ref(7), [
          {
            filename: "shared/a.ts",
            previous_filename: "renderer/a.ts",
            status: "renamed",
            before,
            after,
          },
        ]);
        const diff = unwrap(await h.impl.getDiff(ref(7)));
        expect(applyPatch(before, diff.files[0].patch)).toBe(after);
        expect(diff.files[0].patch).toMatch(/--- a\/renderer\/a.ts/);
        expect(diff.files[0].patch).toMatch(/\+\+\+ b\/shared\/a.ts/);
      });

      it("recovers added, empty, deleted and CRLF sources including missing final newlines", async () => {
        const changes = [
          { filename: "added.ts", status: "added", after: "const emoji = '🎉';" },
          { filename: "empty.ts", status: "added", after: "" },
          { filename: "deleted.ts", status: "removed", before: "removed\n" },
          { filename: "crlf.ts", status: "modified", before: "a\r\nb\r\n", after: "a\r\nc" },
        ];
        seed(7);
        w.setFiles(ref(7), changes);
        const diff = unwrap(await h.impl.getDiff(ref(7)));
        expect(diff.complete).toBe(true);
        expect(diff.files).toHaveLength(changes.length);
        changes.forEach((c, i) => {
          expect(applyPatch((c as { before?: string }).before ?? "", diff.files[i].patch)).toBe(
            (c as { after?: string }).after ?? "",
          );
        });
        expect(diff.files[0].patch).toMatch(/No newline at end of file/);
      });

      it("new files recover without needing a merge-base request", async () => {
        seed(7);
        w.failMergeBase = true;
        w.setFiles(ref(7), [{ filename: "new.ts", status: "added", after: "added\n" }]);
        expect(unwrap(await h.impl.getDiff(ref(7))).complete).toBe(true);
        expect(w.count("compare")).toBe(0);
      });

      for (const variant of [
        "invalid-utf8",
        "binary-controls",
        "only-nul",
        "fetch-failure",
        "truncated",
        "merge-base-failure",
      ]) {
        it(`unrecoverable source (${variant}) stays incomplete and names the file`, async () => {
          seed(7);
          const after =
            variant === "invalid-utf8"
              ? Buffer.from([255, 216])
              : variant === "binary-controls"
                ? Buffer.from([1, 2, 3])
                : variant === "only-nul"
                  ? "\0\0"
                  : "new\n";
          w.setFiles(ref(7), [
            { filename: "src/file.ts", status: "modified", before: "old\n", after },
          ]);
          w.failBlobs = variant === "fetch-failure";
          w.truncateBlobs = variant === "truncated";
          w.failMergeBase = variant === "merge-base-failure";
          const diff = unwrap(await h.impl.getDiff(ref(7)));
          expect(diff.complete).toBe(false);
          expect(diff.incompleteReason).toContain("src/file.ts");
          expect(diff.files).toEqual([]);
        });
      }

      it("a short file list is incomplete and reports the counts", async () => {
        seed(7, { reportedChangedFiles: 2 });
        w.setFiles(ref(7), [{ filename: "a.ts", status: "modified", patch }]);
        const diff = unwrap(await h.impl.getDiff(ref(7)));
        expect(diff.complete).toBe(false);
        expect(diff.incompleteReason).toContain("1/2");
      });

      it("returns conflict when the head moves while the diff is being read", async () => {
        seed(7, { headSha: "h1" });
        w.setFiles(ref(7), [{ filename: "a.ts", status: "modified", patch }]);
        w.pushHeadOnFilesRead(ref(7), "h2");
        expect(errorOf(await h.impl.getDiff(ref(7))).kind).toBe("conflict");
      });
    });

    describe("comments", () => {
      it("finds nothing, creates, then finds the comment by marker (dedupe)", async () => {
        seed(8);
        const marker = "<!-- review:abc -->";
        expect(unwrap(await h.impl.findCommentByMarker(ref(8), marker))).toBeNull();
        const created = unwrap(await h.impl.createComment(ref(8), `body\n\n${marker}`));
        expect(created.id).toEqual(expect.any(Number));
        expect(unwrap(await h.impl.findCommentByMarker(ref(8), marker))).toEqual({
          id: created.id,
        });
        expect(
          unwrap(await h.impl.findCommentByMarker(ref(8), "<!-- review:other -->")),
        ).toBeNull();
      });

      it("finds the marker on a later page of comments", async () => {
        seed(8);
        for (let i = 0; i < 150; i++) w.addComment(ref(8), `noise ${i}`, "someone");
        const target = w.addComment(ref(8), "has <!-- m:1 -->", "someone");
        expect(unwrap(await h.impl.findCommentByMarker(ref(8), "<!-- m:1 -->"))).toEqual({
          id: target.id,
        });
      });
    });

    describe("reviews", () => {
      const marker = "<!-- review:abc -->";

      it("submits and then finds the review by marker, commit and state", async () => {
        seed(9, { headSha: "h1" });
        const sub = unwrap(
          await h.impl.submitReview(ref(9), {
            event: "REQUEST_CHANGES",
            body: `x ${marker}`,
            commitId: "h1",
          }),
        );
        expect(unwrap(await h.impl.findReviewByMarker(ref(9), marker))).toEqual({
          id: sub.id,
          commitId: "h1",
          state: "CHANGES_REQUESTED",
        });
        expect(
          unwrap(await h.impl.findReviewByMarker(ref(9), marker, { commitId: "other" })),
        ).toBeNull();
        expect(
          unwrap(await h.impl.findReviewByMarker(ref(9), marker, { state: "APPROVED" })),
        ).toBeNull();
        expect(unwrap(await h.impl.findReviewByMarker(ref(9), "<!-- nope -->"))).toBeNull();
      });

      it("an APPROVE without a body is found with an empty marker", async () => {
        seed(9, { headSha: "h1" });
        const sub = unwrap(await h.impl.submitReview(ref(9), { event: "APPROVE", commitId: "h1" }));
        expect(
          unwrap(
            await h.impl.findReviewByMarker(ref(9), "", { commitId: "h1", state: "APPROVED" }),
          ),
        ).toEqual({
          id: sub.id,
          commitId: "h1",
          state: "APPROVED",
        });
      });

      it("ignores reviews by other users and returns the latest one", async () => {
        seed(9, { headSha: "h1" });
        w.addReview(ref(9), {
          user: "someone-else",
          body: marker,
          state: "APPROVED",
          commitId: "h1",
        });
        expect(unwrap(await h.impl.findReviewByMarker(ref(9), marker))).toBeNull();
        const mine1 = w.addReview(ref(9), { body: marker, state: "COMMENTED", commitId: "h1" });
        const mine2 = w.addReview(ref(9), { body: marker, state: "APPROVED", commitId: "h1" });
        expect(mine2.id).toBeGreaterThan(mine1.id);
        expect(unwrap(await h.impl.findReviewByMarker(ref(9), marker))?.id).toBe(mine2.id);
      });

      it("COMMENT and REQUEST_CHANGES without a body still submit", async () => {
        seed(9, { headSha: "h1" });
        expect(
          unwrap(await h.impl.submitReview(ref(9), { event: "COMMENT", commitId: "h1" })).id,
        ).toEqual(expect.any(Number));
        expect(w.listReviews(ref(9))[0].body.trim()).not.toBe("");
      });
    });

    describe("getChecks", () => {
      const REPO_REF = { owner: OWNER, repo: REPO };
      const SHA = "c0ffee1";
      const checks = (sha = SHA) => h.impl.getChecks(REPO_REF, sha);
      const run = (name: string, status = "completed", conclusion: string | null = "success") =>
        w.addCheckRun(REPO_REF, SHA, { name, status, conclusion });
      const status = (context: string, state: string) =>
        w.addCommitStatus(REPO_REF, SHA, { context, state });

      it("a commit without any checks is green with total 0", async () => {
        expect(unwrap(await checks())).toEqual({
          state: "green",
          failing: [],
          pending: [],
          total: 0,
        });
      });

      it("success, neutral and skipped runs plus a success status are green", async () => {
        run("build");
        run("lint", "completed", "neutral");
        run("docs", "completed", "skipped");
        status("ci/legacy", "success");
        expect(unwrap(await checks())).toEqual({
          state: "green",
          failing: [],
          pending: [],
          total: 4,
        });
      });

      it("an unfinished run or a pending status is pending and named, sorted", async () => {
        run("test");
        run("build", "in_progress", null);
        status("ci/legacy", "pending");
        expect(unwrap(await checks())).toEqual({
          state: "pending",
          failing: [],
          pending: ["build", "ci/legacy"],
          total: 3,
        });
      });

      it("failed and unknown conclusions fail closed and outrank pending", async () => {
        run("test", "completed", "failure");
        run("lint", "completed", "action_required");
        run("e2e", "completed", null);
        run("build", "queued", null);
        expect(unwrap(await checks())).toEqual({
          state: "failing",
          failing: ["e2e", "lint", "test"],
          pending: ["build"],
          total: 4,
        });
      });

      it("only the newest status per context counts; error and failure fail", async () => {
        status("ci/a", "failure");
        status("ci/a", "success");
        status("ci/b", "success");
        status("ci/b", "error");
        expect(unwrap(await checks())).toEqual({
          state: "failing",
          failing: ["ci/b"],
          pending: [],
          total: 2,
        });
      });

      it("a re-run that passes supersedes the earlier failed run of the same name", async () => {
        run("test", "completed", "failure");
        run("test", "completed", "success");
        expect(unwrap(await checks())).toEqual({
          state: "green",
          failing: [],
          pending: [],
          total: 1,
        });
      });

      it("checks belong to one commit", async () => {
        run("test", "completed", "failure");
        expect(unwrap(await checks("other1"))).toMatchObject({ state: "green", total: 0 });
      });

      it("follows pagination past 100 check runs and statuses", async () => {
        for (let i = 0; i < 120; i++) run(`run-${i}`);
        for (let i = 0; i < 110; i++) status(`status-${i}`, "success");
        status("status-late", "failure");
        expect(unwrap(await checks())).toEqual({
          state: "failing",
          failing: ["status-late"],
          pending: [],
          total: 231,
        });
      });

      it("a malformed SHA is validation and sends no request", async () => {
        const before = w.calls.length;
        expect(errorOf(await checks("../../x")).kind).toBe("validation");
        expect(errorOf(await checks("")).kind).toBe("validation");
        expect(w.calls.length).toBe(before);
      });
    });

    describe("hasApproval", () => {
      const approval = async (number: number, sha: string) =>
        unwrap(await h.impl.hasApproval(ref(number), sha));
      const review = (state: string, commitId = "h1", user?: string) =>
        w.addReview(ref(20), { state, commitId, ...(user ? { user } : {}) });

      it("no reviews is not an approval", async () => {
        seed(20, { headSha: "h1" });
        expect(await approval(20, "h1")).toBe(false);
      });

      it("my latest state-bearing review approving that SHA is an approval", async () => {
        seed(20, { headSha: "h1" });
        review("APPROVED");
        expect(await approval(20, "h1")).toBe(true);
      });

      it("an approval made on another SHA does not count for this one", async () => {
        seed(20, { headSha: "h1" });
        review("APPROVED", "h1");
        w.pushHead(ref(20), "h2");
        expect(await approval(20, "h2")).toBe(false);
        expect(await approval(20, "h1")).toBe(true);
      });

      it("a later CHANGES_REQUESTED revokes it and a later APPROVED restores it", async () => {
        seed(20, { headSha: "h1" });
        review("APPROVED");
        review("CHANGES_REQUESTED");
        expect(await approval(20, "h1")).toBe(false);
        review("APPROVED");
        expect(await approval(20, "h1")).toBe(true);
      });

      it("comments, dismissed and pending reviews after an approval are ignored", async () => {
        seed(20, { headSha: "h1" });
        review("APPROVED");
        review("COMMENTED");
        review("DISMISSED");
        review("PENDING");
        expect(await approval(20, "h1")).toBe(true);
      });

      it("a dismissed approval on its own is not an approval", async () => {
        seed(20, { headSha: "h1" });
        review("DISMISSED");
        expect(await approval(20, "h1")).toBe(false);
      });

      it("other users' approvals do not count; my login matches case-insensitively", async () => {
        seed(20, { headSha: "h1" });
        review("APPROVED", "h1", "someone-else");
        expect(await approval(20, "h1")).toBe(false);
        review("APPROVED", "h1", "Reviewer-Bot");
        expect(await approval(20, "h1")).toBe(true);
        // Another user's later CHANGES_REQUESTED does not touch my decision.
        review("CHANGES_REQUESTED", "h1", "someone-else");
        expect(await approval(20, "h1")).toBe(true);
      });

      it("a malformed SHA is validation and sends no request", async () => {
        seed(20, { headSha: "h1" });
        const before = w.calls.length;
        expect(errorOf(await h.impl.hasApproval(ref(20), "")).kind).toBe("validation");
        expect(errorOf(await h.impl.hasApproval(ref(20), "a/b")).kind).toBe("validation");
        expect(w.calls.length).toBe(before);
      });
    });

    describe("mergeable", () => {
      const reads = () => w.count("pr_read");
      const mergeability = async (n: number, options?: { awaitMergeable?: boolean }) => {
        const pr = unwrap(await h.impl.getPullRequest(ref(n), options));
        return [pr.mergeable, pr.mergeableState];
      };

      it("reports GitHub's mergeable flag and mergeable state", async () => {
        seed(30, { mergeable: false, mergeableState: "dirty" });
        seed(31);
        expect(await mergeability(30)).toEqual([false, "dirty"]);
        expect(await mergeability(31)).toEqual([true, "clean"]);
      });

      it("an unrecognised mergeable state is reported as unknown", async () => {
        seed(32, { mergeableState: "surprise" });
        expect(await mergeability(32)).toEqual([true, "unknown"]);
      });

      it("while GitHub is still computing, a plain read reports null once and does not wait", async () => {
        seed(33);
        w.setMergeableComputing(ref(33), 5);
        expect(await mergeability(33)).toEqual([null, "unknown"]);
        expect(reads()).toBe(1);
      });

      it("awaitMergeable re-reads until GitHub has computed the flag", async () => {
        seed(33, { mergeable: false, mergeableState: "dirty" });
        w.setMergeableComputing(ref(33), 2);
        expect(await mergeability(33, { awaitMergeable: true })).toEqual([false, "dirty"]);
        expect(reads()).toBe(3);
      });

      it("awaitMergeable gives up after MERGEABLE_MAX_READS reads and reports unknown", async () => {
        seed(33);
        w.setMergeableComputing(ref(33), 100);
        expect(await mergeability(33, { awaitMergeable: true })).toEqual([null, "unknown"]);
        expect(reads()).toBe(MERGEABLE_MAX_READS);
      });

      it("awaitMergeable does not re-read a closed or merged PR", async () => {
        seed(34, { state: "closed" });
        seed(35, { state: "closed", merged: true });
        w.setMergeableComputing(ref(34), 5);
        w.setMergeableComputing(ref(35), 5);
        expect(await mergeability(34, { awaitMergeable: true })).toEqual([null, "unknown"]);
        expect(await mergeability(35, { awaitMergeable: true })).toEqual([null, "unknown"]);
        expect(reads()).toBe(2);
      });

      it("a re-read that fails keeps the earlier read: unknown, not an error", async () => {
        seed(36, { headSha: "h1" });
        w.setMergeableComputing(ref(36), 5);
        w.failAfterReads(1, { kind: "bad_gateway" });
        const pr = unwrap(await h.impl.getPullRequest(ref(36), { awaitMergeable: true }));
        expect([pr.sha, pr.mergeable, pr.mergeableState]).toEqual(["h1", null, "unknown"]);
      });

      it("a PR GitHub reports as not mergeable cannot be merged: conflict, PR stays open", async () => {
        seed(37, { headSha: "h1", mergeable: false, mergeableState: "dirty" });
        expect(errorOf(await h.impl.merge(ref(37), { sha: "h1" })).kind).toBe("conflict");
        expect(w.getPr(ref(37))?.merged).toBe(false);
      });
    });

    describe("merge", () => {
      it("merges when the SHA matches and flips the PR to merged/closed", async () => {
        seed(10, { headSha: "h1" });
        const merged = unwrap(await h.impl.merge(ref(10), { sha: "h1" }));
        expect(merged.merged).toBe(true);
        expect(merged.sha).toEqual(expect.any(String));
        const pr = unwrap(await h.impl.getPullRequest(ref(10)));
        expect([pr.merged, pr.state]).toEqual([true, "closed"]);
      });

      it("a stale SHA is a conflict and leaves the PR open", async () => {
        seed(10, { headSha: "h2" });
        const error = errorOf(await h.impl.merge(ref(10), { sha: "h1" }));
        expect(error.kind).toBe("conflict");
        expect(unwrap(await h.impl.getPullRequest(ref(10))).merged).toBe(false);
      });

      it("uses the configured method when the call names none", async () => {
        seed(10, { headSha: "h1" });
        unwrap(await h.impl.merge(ref(10), { sha: "h1" }));
        expect(w.getPr(ref(10))?.mergeMethod).toBe("merge");
      });

      it("a per-call method overrides the configured one", async () => {
        seed(10, { headSha: "h1" });
        unwrap(await h.impl.merge(ref(10), { sha: "h1", method: "squash" }));
        expect(w.getPr(ref(10))?.mergeMethod).toBe("squash");
      });

      it("a method the repository disallows is a conflict and leaves the PR open", async () => {
        seed(10, { headSha: "h1" });
        w.setMergeSettings({ owner: OWNER, repo: REPO }, { rebase: false });
        expect(errorOf(await h.impl.merge(ref(10), { sha: "h1", method: "rebase" })).kind).toBe(
          "conflict",
        );
        expect(unwrap(await h.impl.getPullRequest(ref(10))).merged).toBe(false);
      });

      it("an unknown method or a malformed SHA is validation and sends no request", async () => {
        seed(10, { headSha: "h1" });
        const before = w.calls.length;
        const bogus = "fast-forward" as MergeMethod;
        expect(errorOf(await h.impl.merge(ref(10), { sha: "h1", method: bogus })).kind).toBe(
          "validation",
        );
        expect(errorOf(await h.impl.merge(ref(10), { sha: "../h1" })).kind).toBe("validation");
        expect(w.calls.length).toBe(before);
        expect(w.getPr(ref(10))?.merged).toBe(false);
      });

      it("a draft or already-merged PR is a conflict", async () => {
        seed(10, { headSha: "h1", draft: true });
        expect(errorOf(await h.impl.merge(ref(10), { sha: "h1" })).kind).toBe("conflict");
        seed(11, { headSha: "h1" });
        unwrap(await h.impl.merge(ref(11), { sha: "h1" }));
        expect(errorOf(await h.impl.merge(ref(11), { sha: "h1" })).kind).toBe("conflict");
      });
    });

    describe("listAccessibleRepos", () => {
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) =>
          w.addAccessibleRepo({ fullName: `org/repo-${String(i).padStart(4, "0")}` }),
        );

      it("no repos: an empty, complete list", async () => {
        expect(unwrap(await h.impl.listAccessibleRepos())).toEqual({ repos: [], truncated: false });
      });

      it("returns every repo with its flags, sorted by full name", async () => {
        w.addAccessibleRepo({ fullName: "zeta/app", canPush: true });
        w.addAccessibleRepo({ fullName: "Acme/Web", private: true, canPush: false });
        w.addAccessibleRepo({ fullName: "acme/old", archived: true, canPush: true });
        expect(unwrap(await h.impl.listAccessibleRepos())).toEqual({
          repos: [
            { fullName: "acme/old", private: false, archived: true, canPush: true },
            { fullName: "Acme/Web", private: true, archived: false, canPush: false },
            { fullName: "zeta/app", private: false, archived: false, canPush: true },
          ],
          truncated: false,
        });
      });

      it("follows pages: 250 repos are all returned", async () => {
        many(250);
        const list = unwrap(await h.impl.listAccessibleRepos());
        expect(list.repos).toHaveLength(250);
        expect(list.repos.at(-1)?.fullName).toBe("org/repo-0249");
        expect(list.truncated).toBe(false);
      });

      it("exactly the page cap is complete; one more is truncated", async () => {
        const cap = ACCESSIBLE_REPOS_MAX_PAGES * ACCESSIBLE_REPOS_PAGE_SIZE;
        many(cap);
        expect(unwrap(await h.impl.listAccessibleRepos())).toMatchObject({ truncated: false });
        w.addAccessibleRepo({ fullName: "zzz/last" });
        const list = unwrap(await h.impl.listAccessibleRepos());
        expect(list.repos).toHaveLength(cap);
        expect(list.repos.some((r) => r.fullName === "zzz/last")).toBe(false);
        expect(list.truncated).toBe(true);
      });

      it("a rejected token (401) is forbidden", async () => {
        w.failNext({ kind: "unauthorized" });
        expect(errorOf(await h.impl.listAccessibleRepos()).kind).toBe("forbidden");
      });

      it("rate limit and 502 map like every other call", async () => {
        w.failNext({ kind: "rate_limited", retryAfterSec: 30 });
        expect(errorOf(await h.impl.listAccessibleRepos())).toEqual({
          kind: "rate_limited",
          retryAfterMs: 30_000,
        });
        w.failNext({ kind: "bad_gateway" });
        expect(errorOf(await h.impl.listAccessibleRepos())).toEqual({
          kind: "upstream",
          service: "github",
          retryable: true,
        });
      });
    });

    describe("errors", () => {
      it("unknown PR is not_found for every PR-scoped method", async () => {
        const calls: (() => Promise<Result<unknown, DomainError>>)[] = [
          () => h.impl.getPullRequest(ref(404)),
          () => h.impl.getDiff(ref(404)),
          () => h.impl.findCommentByMarker(ref(404), "m"),
          () => h.impl.createComment(ref(404), "b"),
          () => h.impl.findReviewByMarker(ref(404), "m"),
          () => h.impl.submitReview(ref(404), { event: "APPROVE" }),
          () => h.impl.hasApproval(ref(404), "x"),
          () => h.impl.merge(ref(404), { sha: "x" }),
        ];
        for (const call of calls) {
          expect(errorOf(await call()).kind).toBe("not_found");
        }
      });

      it("rate limit becomes rate_limited with retryAfterMs", async () => {
        seed(12);
        w.failNext({ kind: "rate_limited", retryAfterSec: 30 });
        expect(errorOf(await h.impl.getPullRequest(ref(12)))).toEqual({
          kind: "rate_limited",
          retryAfterMs: 30_000,
        });
      });

      it("a 502 becomes a retryable upstream error", async () => {
        seed(12);
        w.failNext({ kind: "bad_gateway" });
        expect(errorOf(await h.impl.getPullRequest(ref(12)))).toEqual({
          kind: "upstream",
          service: "github",
          retryable: true,
        });
      });

      it("a plain 403 becomes forbidden", async () => {
        seed(12);
        w.failNext({ kind: "forbidden" });
        expect(errorOf(await h.impl.getPullRequest(ref(12))).kind).toBe("forbidden");
      });
    });
  });
}
