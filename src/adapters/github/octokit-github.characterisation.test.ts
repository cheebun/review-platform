import { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPullRequest, listOpenPullRequests } from "../../lib/github";
import type { PrRef } from "../../domain/github/pr-ref";
import { FAKE_GITHUB_BASE_URL, githubHandlers } from "../../testing/http/github/handlers";
import { GithubWorld } from "../../testing/http/github/world";
import { server } from "../../testing/http/server";
import { OctokitGitHub } from "./octokit-github";

/**
 * Characterisation: the new adapter returns the same data as the legacy src/lib functions when
 * both talk to the same fake GitHub. Legacy `listOpenPullRequests` reads Date.now(), so the
 * system time is pinned to the `now` handed to the new adapter.
 */

const NOW = new Date("2026-06-30T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ref: PrRef = {
  owner: "bosinc",
  repo: "katana-web",
  number: 17307,
  url: "https://github.com/bosinc/katana-web/pull/17307",
};

let world: GithubWorld;
let legacy: Octokit;
let adapter: OctokitGitHub;

beforeEach(() => {
  world = new GithubWorld();
  server.use(...githubHandlers(world));
  legacy = new Octokit({ auth: "ghp_fake_token_for_tests", baseUrl: FAKE_GITHUB_BASE_URL });
  adapter = new OctokitGitHub({
    token: "ghp_fake_token_for_tests",
    userAgent: "agent-ops-test",
    baseUrl: FAKE_GITHUB_BASE_URL,
  });
});
afterEach(() => vi.useRealTimers());

describe("listOpenPullRequests parity", () => {
  it("returns the same items as src/lib/github.ts", async () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const base = { owner: ref.owner, repo: ref.repo };
    world.addPr({
      ...base,
      number: 1,
      author: "Lijun1m",
      updatedAt: at(DAY),
      reviewDecision: "APPROVED",
    });
    world.addPr({ ...base, number: 2, author: "tian-1m", updatedAt: at(2 * DAY) });
    world.addPr({ ...base, number: 3, author: "lijun1m", updatedAt: at(3 * DAY), draft: true });
    world.addPr({ ...base, number: 4, author: "outsider", updatedAt: at(DAY) });
    world.addPr({ ...base, number: 5, author: "lijun1m", updatedAt: at(15 * DAY) });
    world.addPr({ ...base, number: 6, author: "lijun1m", updatedAt: at(15 * DAY + 1000) });
    world.addPr({ ...base, number: 7, author: "lijun1m", updatedAt: at(DAY), state: "closed" });

    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const old = await listOpenPullRequests(legacy, ref.owner, ref.repo, ["lijun1m", "tian-1m"], 15);
    vi.useRealTimers();
    const next = await adapter.listOpenPullRequests(
      { owner: ref.owner, repo: ref.repo },
      { authors: ["lijun1m", "tian-1m"], maxAgeDays: 15, now: NOW },
    );
    expect(old.map((i) => i.number)).toEqual([1, 2, 5]);
    expect(next).toEqual({ ok: true, value: old });
  });
});

describe("diff recovery parity", () => {
  const scenarios: [string, Parameters<GithubWorld["setFiles"]>[1]][] = [
    [
      "inline patch",
      [
        {
          filename: "src/a.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old\n+new",
          additions: 1,
          deletions: 1,
        },
      ],
    ],
    [
      "pure renames",
      [
        {
          filename: "shared/a.ts",
          previous_filename: "renderer/a.ts",
          status: "renamed",
          before: "same",
          after: "same",
        },
      ],
    ],
    [
      "NUL source",
      [
        {
          filename: "src/Canvas.tsx",
          status: "modified",
          before: 'join("\0")\n',
          after: 'join("\\0")\n',
        },
      ],
    ],
    [
      "added, empty, deleted, CRLF",
      [
        { filename: "added.ts", status: "added", after: "const emoji = '🎉';" },
        { filename: "empty.ts", status: "added", after: "" },
        { filename: "deleted.ts", status: "removed", before: "removed\n" },
        { filename: "crlf.ts", status: "modified", before: "a\r\nb\r\n", after: "a\r\nc" },
      ],
    ],
    [
      "renamed and edited",
      [
        {
          filename: "shared/a.ts",
          previous_filename: "renderer/a.ts",
          status: "renamed",
          before: "a = 1\n",
          after: "a = 2\n",
        },
      ],
    ],
  ];

  for (const [name, files] of scenarios) {
    it(`${name}: same files, header and patch`, async () => {
      world.addPr({ ...ref, baseSha: "base-tip-sha", headSha: "head-sha" });
      world.setFiles(ref, files);
      const old = await fetchPullRequest(legacy, ref);
      const next = await adapter.getDiff(ref);
      if (!next.ok) throw new Error("expected ok");
      expect(old.complete).toBe(true);
      expect(next.value.complete).toBe(true);
      expect(next.value.files).toEqual(old.diffFiles);
      expect(next.value.meta).toMatchObject({
        sha: old.sha,
        baseSha: old.baseSha,
        title: old.title,
        author: old.author,
      });
    });
  }

  it("unrecoverable source: both report incomplete and name the file (reason text is now English)", async () => {
    world.addPr({ ...ref });
    world.setFiles(ref, [
      {
        filename: "src/file.ts",
        status: "modified",
        before: "old\n",
        after: Buffer.from([255, 216]),
      },
    ]);
    const old = await fetchPullRequest(legacy, ref);
    const next = await adapter.getDiff(ref);
    if (!next.ok) throw new Error("expected ok");
    expect(next.value.complete).toBe(old.complete);
    expect(next.value.files).toEqual(old.diffFiles);
    expect(old.incompleteReason).toContain("src/file.ts");
    expect(next.value.incompleteReason).toContain("src/file.ts");
  });

  it("head moves during the read: legacy throws, the adapter returns conflict", async () => {
    world.addPr({ ...ref, headSha: "h1" });
    world.setFiles(ref, [{ filename: "a.ts", status: "modified", patch: "@@" }]);
    world.pushHeadOnFilesRead(ref, "h2");
    await expect(fetchPullRequest(legacy, ref)).rejects.toThrow();
    world.pushHead(ref, "h1");
    world.pushHeadOnFilesRead(ref, "h3");
    const next = await adapter.getDiff(ref);
    expect(next).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });
});
