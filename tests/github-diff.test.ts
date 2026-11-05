import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import type { Octokit } from "@octokit/rest";
import { applyPatch } from "diff";
import { fetchPullRequest } from "../src/lib/github";
import { shipPullRequest } from "../src/lib/ship-pr";

const ref = {
  owner: "bosinc",
  repo: "katana-web",
  number: 17307,
  url: "https://github.com/bosinc/katana-web/pull/17307",
};

type Change = {
  filename: string;
  previous_filename?: string;
  status: string;
  before?: string | Buffer;
  after?: string | Buffer;
  patch?: string;
  additions?: number;
  deletions?: number;
};

function fixture(changes: Change[]) {
  const blobs = new Map<string, Buffer>();
  const oldFiles = new Map<string, string>();
  const calls: { operation: string; params: Record<string, unknown> }[] = [];
  const state = {
    head: "head-sha",
    base: "base-tip-sha",
    changedFiles: changes.length,
    failCompare: false,
    failBlob: false,
    truncateBlob: false,
    changeDuringRead: false,
  };
  const store = (content: string | Buffer) => {
    const bytes = Buffer.from(content);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    blobs.set(sha, bytes);
    return sha;
  };
  const files = changes.map((change) => {
    const oldSha = change.before == null ? undefined : store(change.before);
    if (oldSha) oldFiles.set(change.previous_filename ?? change.filename, oldSha);
    const sha = change.after == null ? oldSha : store(change.after);
    return {
      ...change,
      sha,
      additions: change.additions ?? 0,
      deletions: change.deletions ?? 0,
    };
  });
  const fake = {
    users: { getAuthenticated: async () => ({ data: { login: "zhiyong-eng" } }) },
    pulls: {
      get: async () => ({
        data: {
          title: "Move renderer modules",
          body: "Description",
          user: { login: "tian-1m" },
          base: { ref: "main", sha: state.base },
          head: { ref: "branch", sha: state.head },
          html_url: ref.url,
          draft: false,
          state: "open",
          merged: false,
          changed_files: state.changedFiles,
        },
      }),
      listFiles: async () => {},
      createReview: async (params: Record<string, unknown>) => {
        calls.push({ operation: "review", params });
        return { data: { id: 2 } };
      },
      merge: async () => {
        assert.fail("Protected author's PR must not merge");
      },
    },
    issues: {
      createComment: async (params: Record<string, unknown>) => {
        calls.push({ operation: "comment", params });
        return { data: { id: 1 } };
      },
    },
    repos: {
      compareCommits: async (params: Record<string, unknown>) => {
        calls.push({ operation: "compare", params });
        assert.equal(params.base, "base-tip-sha");
        assert.equal(params.head, "head-sha");
        if (state.failCompare) throw new Error("Merge base unavailable");
        return { data: { merge_base_commit: { sha: "merge-base-sha" } } };
      },
      getContent: async (params: Record<string, unknown>) => {
        calls.push({ operation: "content", params });
        assert.equal(params.ref, "merge-base-sha");
        const sha = oldFiles.get(params.path as string);
        if (!sha) throw new Error("File not found at merge base");
        if (state.changeDuringRead) state.head = "new-head-sha";
        // Metadata only: the contents API may omit inline content for large files.
        return { data: { type: "file", sha, encoding: "none", content: "" } };
      },
    },
    git: {
      getBlob: async (params: Record<string, unknown>) => {
        calls.push({ operation: "blob", params });
        if (state.failBlob) throw new Error("Source unavailable");
        const bytes = blobs.get(params.file_sha as string);
        if (!bytes) throw new Error("Blob not found");
        return {
          data: {
            sha: params.file_sha,
            encoding: "base64",
            size: bytes.length,
            content: (state.truncateBlob ? bytes.subarray(0, 1) : bytes).toString("base64"),
          },
        };
      },
    },
    paginate: async () => files,
  };
  return { octokit: fake as unknown as Octokit, calls, state };
}

test("keeps GitHub patches intact without extra recovery requests", async () => {
  const patch = "@@ -1 +1 @@\n-old\n+new";
  const fake = fixture([{ filename: "src/a.ts", status: "modified", patch }]);
  const pr = await fetchPullRequest(fake.octokit, ref);
  assert.equal(pr.complete, true);
  assert.equal(pr.diffFiles[0].patch, patch);
  assert.deepEqual(fake.calls, []);
});

test("verifies pure renames by blob SHA and includes both paths in the review", async () => {
  const fake = fixture([
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
      before: "also same",
      after: "also same",
    },
  ]);
  const pr = await fetchPullRequest(fake.octokit, ref);
  assert.equal(pr.complete, true);
  assert.equal(pr.diffFiles.length, 2);
  assert.match(pr.diffFiles[0].header, /Previous path: renderer\/a.ts/);
  assert.match(
    pr.diffFiles[0].patch,
    /similarity index 100%\nrename from renderer\/a.ts\nrename to shared\/a.ts/,
  );
  assert.equal(fake.calls.filter((call) => call.operation === "compare").length, 1);
  assert.equal(fake.calls.filter((call) => call.operation === "blob").length, 0);
});

test("recovers a NUL-containing old source without confusing it with a literal escape", async () => {
  const before = 'const key = [a, b].join("\0");\nconst other = "\0";\n';
  const after = 'const key = [a, b].join("\\0");\nconst other = "\\0";\n';
  const fake = fixture([{ filename: "src/Canvas.tsx", status: "modified", before, after }]);
  const pr = await fetchPullRequest(fake.octokit, ref);
  assert.equal(pr.complete, true);
  const diff = pr.diffFiles[0];
  assert.match(diff.header, /Old file: 2 NUL bytes; new file: 0/);
  assert.equal(diff.patch.includes("\0"), false);
  assert.ok(diff.patch.includes("⟦NUL:0x00⟧"));
  assert.equal(applyPatch(before, diff.patch.replaceAll("⟦NUL:0x00⟧", "\0")), after);
});

test("zero line statistics do not hide edits inside a renamed file", async () => {
  const before = "export const a = 1;\n";
  const after = "export const a = 2;\n";
  const fake = fixture([
    {
      filename: "shared/a.ts",
      previous_filename: "renderer/a.ts",
      status: "renamed",
      before,
      after,
    },
  ]);
  const pr = await fetchPullRequest(fake.octokit, ref);
  assert.equal(pr.complete, true);
  assert.equal(applyPatch(before, pr.diffFiles[0].patch), after);
  assert.match(pr.diffFiles[0].patch, /--- a\/renderer\/a.ts/);
  assert.match(pr.diffFiles[0].patch, /\+\+\+ b\/shared\/a.ts/);
});

test("recovers added, empty, deleted, and CRLF sources including missing final newlines", async () => {
  const changes: Change[] = [
    { filename: "added.ts", status: "added", after: "const emoji = '🎉';" },
    { filename: "empty.ts", status: "added", after: "" },
    { filename: "deleted.ts", status: "removed", before: "removed\n" },
    { filename: "crlf.ts", status: "modified", before: "a\r\nb\r\n", after: "a\r\nc" },
  ];
  const fake = fixture(changes);
  const pr = await fetchPullRequest(fake.octokit, ref);
  assert.equal(pr.complete, true);
  assert.equal(pr.diffFiles.length, changes.length);
  changes.forEach((change, i) => {
    assert.equal(
      applyPatch((change.before ?? "") as string, pr.diffFiles[i].patch),
      change.after ?? "",
    );
  });
  assert.match(pr.diffFiles[0].patch, /No newline at end of file/);
});

test("new files recover without needing a merge-base request", async () => {
  const fake = fixture([{ filename: "new.ts", status: "added", after: "added\n" }]);
  fake.state.failCompare = true;
  assert.equal((await fetchPullRequest(fake.octokit, ref)).complete, true);
  assert.equal(
    fake.calls.some((call) => call.operation === "compare"),
    false,
  );
});

test("binary or unavailable sources remain incomplete and cannot reach AI or GitHub writes", async () => {
  for (const variant of [
    "invalid-utf8",
    "binary-controls",
    "only-nul",
    "fetch-failure",
    "truncated",
    "merge-base-failure",
  ]) {
    const fake = fixture([
      {
        filename: "src/file.ts",
        status: "modified",
        before: "old\n",
        after:
          variant === "invalid-utf8"
            ? Buffer.from([255, 216])
            : variant === "binary-controls"
              ? Buffer.from([1, 2, 3])
              : variant === "only-nul"
                ? "\0\0"
                : "new\n",
      },
    ]);
    fake.state.failBlob = variant === "fetch-failure";
    fake.state.truncateBlob = variant === "truncated";
    fake.state.failCompare = variant === "merge-base-failure";
    const pr = await fetchPullRequest(fake.octokit, ref);
    assert.equal(pr.complete, false, variant);
    assert.match(pr.incompleteReason!, /src\/file.ts/);
    let reviewed = false;
    await assert.rejects(
      shipPullRequest(ref.url, "zhiyong-eng", {
        octokit: fake.octokit,
        review: async () => {
          reviewed = true;
          throw new Error("Must not reach AI");
        },
      }),
      /PR Diff 不完整/,
    );
    assert.equal(reviewed, false, variant);
    assert.equal(
      fake.calls.some((call) => ["comment", "review"].includes(call.operation)),
      false,
      variant,
    );
  }
});

test("incomplete file lists and commits changing during recovery still stop approval", async () => {
  const fake = fixture([
    { filename: "src/a.ts", status: "modified", before: "old\n", after: "new\n" },
  ]);
  fake.state.changedFiles = 2;
  const pr = await fetchPullRequest(fake.octokit, ref);
  assert.equal(pr.complete, false);
  assert.match(pr.incompleteReason!, /1\/2/);
  fake.state.changedFiles = 1;
  fake.state.changeDuringRead = true;
  await assert.rejects(fetchPullRequest(fake.octokit, ref), /读取 Diff 时发生更新/);
});

test("Ship reviews recovered sources and moves together before any GitHub writes", async () => {
  const fake = fixture([
    {
      filename: "src/Canvas.tsx",
      status: "modified",
      before: 'join("\0")\n',
      after: 'join("\\0")\n',
    },
    {
      filename: "shared/types.ts",
      previous_filename: "renderer/types.ts",
      status: "renamed",
      before: "same\n",
      after: "same\n",
    },
  ]);
  let aiCalls = 0;
  const result = await shipPullRequest(ref.url, "zhiyong-eng", {
    octokit: fake.octokit,
    review: async ({ diffText }) => {
      aiCalls++;
      assert.match(diffText, /Canvas.tsx/);
      assert.match(diffText, /⟦NUL:0x00⟧/);
      assert.match(diffText, /rename from renderer\/types.ts/);
      assert.match(diffText, /rename to shared\/types.ts/);
      assert.equal(
        fake.calls.some((call) => ["comment", "review"].includes(call.operation)),
        false,
      );
      return { summary: "Reviewed full changes", findings: [], verificationRequests: [] };
    },
  });
  assert.equal(aiCalls, 1);
  assert.equal(result.approved, true);
  assert.equal(result.merged, false);
  assert.deepEqual(
    fake.calls
      .filter((call) => ["comment", "review"].includes(call.operation))
      .map((call) => call.operation),
    ["comment", "review"],
  );
  assert.equal(
    fake.calls.find((call) => call.operation === "review")!.params.commit_id,
    "head-sha",
  );
});
