import assert from "node:assert/strict";
import { test } from "vitest";
import type { Octokit } from "@octokit/rest";
import { shipPullRequest, type ShipProgress } from "../src/lib/ship-pr";
import { toAiReviewResult } from "../src/lib/review-ai";
import { ReviewDeferredError } from "../src/lib/review-input";
import type { AiReviewResult } from "../src/lib/types";

const url = "https://github.com/bosinc/katana-web/pull/17190";
const clean: AiReviewResult = {
  summary: "Changed form validation",
  findings: [],
  verificationRequests: ["Verify validation"],
};

function fixture(author = "lijun1m") {
  let sha = "reviewed-sha";
  let merged = false;
  let mergeFails = false;
  let patch: string | undefined = "@@ -1 +1 @@\n-old\n+new";
  let changedFiles = 1;
  const calls: { operation: string; params: Record<string, unknown> }[] = [];
  const listComments = async () => {};
  const listReviews = async () => {};
  const fake = {
    users: { getAuthenticated: async () => ({ data: { login: "zhiyong-eng" } }) },
    pulls: {
      get: async () => ({
        data: {
          title: "Test PR",
          body: "Description",
          user: { login: author },
          base: { ref: "main", sha: "base-sha" },
          head: { ref: "branch", sha },
          html_url: url,
          draft: false,
          state: merged ? "closed" : "open",
          merged,
          changed_files: changedFiles,
        },
      }),
      listFiles: async () => {},
      listReviews,
      createReview: async (params: Record<string, unknown>) => {
        calls.push({ operation: "review", params });
        return { data: { id: 2 } };
      },
      merge: async (params: Record<string, unknown>) => {
        calls.push({ operation: "merge", params });
        if (mergeFails) throw new Error("Required check failed");
        merged = true;
        return { data: { merged: true, message: "Merged" } };
      },
    },
    issues: {
      listComments,
      createComment: async (params: Record<string, unknown>) => {
        calls.push({ operation: "comment", params });
        return { data: { id: 1 } };
      },
    },
    paginate: async (method: unknown) =>
      method === listComments || method === listReviews
        ? []
        : [{ filename: "src/form.ts", status: "modified", additions: 1, deletions: 1, patch }],
  };
  return {
    octokit: fake as unknown as Octokit,
    calls,
    updateSha: () => {
      sha = "new-sha";
    },
    setMergeFailure: (value: boolean) => {
      mergeFails = value;
    },
    setPatch: (value: string | undefined) => {
      patch = value;
    },
    setChangedFiles: (value: number) => {
      changedFiles = value;
    },
  };
}

test("rejects missing findings and malformed blockers instead of silently approving", () => {
  for (const raw of [
    {},
    { summary: "Test" },
    { summary: "Test", findings: [{ severity: "P0", title: "Regression" }] },
  ]) {
    assert.throws(() => toAiReviewResult(raw));
  }
  assert.equal(toAiReviewResult(clean).findings.length, 0);
});

test("Ship comments, approves, and merges the exact reviewed commit", async () => {
  const fake = fixture();
  const result = await shipPullRequest(url, "zhiyong-eng", {
    octokit: fake.octokit,
    review: async () => clean,
    restrictToReviewList: true,
  });
  assert.equal(result.merged, true);
  assert.deepEqual(
    fake.calls.map((call) => call.operation),
    ["comment", "review", "merge"],
  );
  assert.equal(fake.calls[1].params.commit_id, "reviewed-sha");
  assert.equal(fake.calls[2].params.sha, "reviewed-sha");
  assert.equal(fake.calls[2].params.merge_method, "merge");
});

test("protected authors approve only; P0 requests changes without merge", async () => {
  const protectedPr = fixture("tian-1m");
  const approved = await shipPullRequest(url, "zhiyong-eng", {
    octokit: protectedPr.octokit,
    review: async () => clean,
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.merged, false);
  const blockedPr = fixture();
  const result = await shipPullRequest(url, "zhiyong-eng", {
    octokit: blockedPr.octokit,
    review: async () => ({
      ...clean,
      findings: [{ severity: "P0", title: "Crash", body: "Reproducible crash" }],
    }),
  });
  assert.equal(result.githubEvent, "REQUEST_CHANGES");
  assert.equal(
    blockedPr.calls.some((call) => call.operation === "merge"),
    false,
  );
});

test("Slack rejects another repository, accepts any other author, and rejects own PRs", async () => {
  const fake = fixture();
  const config = { octokit: fake.octokit, restrictToReviewList: true, review: async () => clean };
  await assert.rejects(
    shipPullRequest("https://github.com/other/repo/pull/1", "zhiyong-eng", config),
  );
  const outside = fixture("outside-author");
  const outsideResult = await shipPullRequest(url, "zhiyong-eng", {
    ...config,
    octokit: outside.octokit,
    allowAnyAuthor: true,
  });
  assert.equal(outsideResult.approved, true);
  await assert.rejects(
    shipPullRequest(url, "zhiyong-eng", {
      ...config,
      octokit: fixture("zhiyong-eng").octokit,
      allowAnyAuthor: true,
    }),
  );
  assert.deepEqual(fake.calls, []);
});

test("changed commits and incomplete diffs stop before writing to GitHub", async () => {
  const changed = fixture();
  await assert.rejects(
    shipPullRequest(url, "zhiyong-eng", {
      octokit: changed.octokit,
      review: async () => {
        changed.updateSha();
        return clean;
      },
    }),
  );
  assert.deepEqual(changed.calls, []);
  for (const patch of [undefined]) {
    const incomplete = fixture();
    incomplete.setPatch(patch);
    let reviewed = false;
    await assert.rejects(
      shipPullRequest(url, "zhiyong-eng", {
        octokit: incomplete.octokit,
        review: async () => {
          reviewed = true;
          return clean;
        },
      }),
    );
    assert.equal(reviewed, false);
    assert.deepEqual(incomplete.calls, []);
  }
});

test("a PR above the old limit is reviewed in one complete request before GitHub writes", async () => {
  const fake = fixture();
  const patch = `@@ -0,0 +1 @@\n+${"x".repeat(1_200_000)}\n+end-of-file`;
  fake.setPatch(patch);
  let aiCalls = 0;
  const result = await shipPullRequest(url, "zhiyong-eng", {
    octokit: fake.octokit,
    review: async (input) => {
      aiCalls++;
      assert.deepEqual(fake.calls, []);
      assert.ok(input.diffText.includes(patch));
      assert.match(input.diffText, /src\/form.ts/);
      assert.equal(input.diffText.includes("Review scope: batch"), false);
      return { ...clean, findings: [{ severity: "P0", title: "Crash", body: "Missing guard" }] };
    },
  });
  assert.equal(aiCalls, 1);
  assert.equal(result.approved, false);
  assert.equal(result.githubEvent, "REQUEST_CHANGES");
  assert.deepEqual(
    fake.calls.map((call) => call.operation),
    ["comment", "review"],
  );
});

test("a failed full review is retried in full without approving or reusing legacy partial results", async () => {
  const fake = fixture();
  const patch = "x".repeat(400_000);
  fake.setPatch(patch);
  let saved: ShipProgress = {};
  let aiCalls = 0;
  await assert.rejects(
    shipPullRequest(url, "zhiyong-eng", {
      octokit: fake.octokit,
      progress: { batchReview: { fingerprint: "old-plan", total: 4, results: [clean] } },
      checkpoint: async (progress) => {
        saved = structuredClone(progress);
      },
      review: async (input) => {
        aiCalls++;
        assert.ok(input.diffText.includes(patch));
        throw new Error("Gateway unavailable");
      },
    }),
    /Gateway unavailable/,
  );
  assert.equal(aiCalls, 1);
  assert.equal(saved.batchReview, undefined);
  assert.equal(saved.review, undefined);
  assert.deepEqual(fake.calls, []);
  let resumedCalls = 0;
  const result = await shipPullRequest(url, "zhiyong-eng", {
    octokit: fake.octokit,
    progress: saved,
    review: async (input) => {
      resumedCalls++;
      assert.ok(input.diffText.includes(patch));
      return { ...clean, findings: [{ severity: "P0", title: "Crash", body: "Missing guard" }] };
    },
  });
  assert.equal(resumedCalls, 1);
  assert.equal(result.githubEvent, "REQUEST_CHANGES");
});

test("defers before starting a review at the deadline and resumes safely", async () => {
  const fake = fixture();
  fake.setPatch("x".repeat(200_000));
  const progress: ShipProgress = {};
  let aiCalls = 0;
  const config = {
    octokit: fake.octokit,
    progress,
    startReviewBefore: 0,
    review: async () => {
      aiCalls++;
      return clean;
    },
  };
  await assert.rejects(shipPullRequest(url, "zhiyong-eng", config), ReviewDeferredError);
  assert.equal(aiCalls, 0);
  assert.equal(progress.review, undefined);
  assert.deepEqual(fake.calls, []);
  const result = await shipPullRequest(url, "zhiyong-eng", {
    ...config,
    startReviewBefore: Infinity,
  });
  assert.equal(aiCalls, 1);
  assert.equal(result.approved, true);
});

test("rejects incomplete file lists, changed commits, and malformed full reviews", async () => {
  const missing = fixture();
  missing.setChangedFiles(2);
  await assert.rejects(
    shipPullRequest(url, "zhiyong-eng", { octokit: missing.octokit, review: async () => clean }),
    /1\/2/,
  );
  assert.deepEqual(missing.calls, []);

  const fake = fixture();
  fake.setPatch("x".repeat(200_000));
  const progress: ShipProgress = {};
  await assert.rejects(
    shipPullRequest(url, "zhiyong-eng", {
      octokit: fake.octokit,
      progress,
      review: async () => ({ ...clean, summary: "" }),
    }),
    /summary/,
  );
  assert.equal(progress.review, undefined);
  assert.deepEqual(fake.calls, []);
  fake.updateSha();
  await assert.rejects(
    shipPullRequest(url, "zhiyong-eng", {
      octokit: fake.octokit,
      progress,
      review: async () => clean,
    }),
    /PR 已更新/,
  );
  assert.deepEqual(fake.calls, []);
});

test("resume a failed merge without repeating AI, comment, or approve", async () => {
  const fake = fixture();
  fake.setMergeFailure(true);
  let aiCalls = 0;
  const progress: ShipProgress = {};
  const config = {
    octokit: fake.octokit,
    progress,
    requestId: "slack-message-id",
    review: async () => {
      aiCalls++;
      return clean;
    },
    checkpoint: async () => {},
  };
  await assert.rejects(shipPullRequest(url, "zhiyong-eng", config));
  assert.equal(progress.githubReviewId, 2);
  fake.setMergeFailure(false);
  const result = await shipPullRequest(url, "zhiyong-eng", config);
  assert.equal(result.merged, true);
  assert.equal(aiCalls, 1);
  assert.deepEqual(
    fake.calls.map((call) => call.operation),
    ["comment", "review", "merge", "merge"],
  );
});
