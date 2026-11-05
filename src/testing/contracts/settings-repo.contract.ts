import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_UNVERIFIED, type RepoPermissions } from "../../domain/settings/permissions";
import type { SettingsRepo, StoredRepo } from "../../ports/settings-repo";
import {
  aRejectedEvent,
  aSettingsEvent,
  type EventfulHarness,
  type MakeEventfulHarness,
} from "./harness";

const T0 = Date.parse("2026-11-04T01:00:00.000Z");

export const aStoredRepo = (
  canonical: string,
  n = 0,
  over: Partial<StoredRepo> = {},
): StoredRepo => {
  const [owner, repo] = canonical.split("/");
  return {
    owner,
    repo,
    canonical,
    access: "ok",
    permissions: ALL_UNVERIFIED,
    checkedAt: new Date(T0 + n * 1000),
    addedAt: new Date(T0 + n * 1000),
    addedBy: "owner-1",
    ...over,
  };
};

const granted: RepoPermissions = {
  pullRequests: { read: "granted", write: "granted" },
  contents: { read: "granted", write: "missing" },
  checks: { read: "granted" },
  statuses: { read: "unverified" },
};

/** Event builders for `addRepo` and `removeRepo`, as the use cases pass them. */
const onAdd = (row: StoredRepo) => aSettingsEvent("github_repo_added", { repo: row.canonical });
const onRemove = (row: StoredRepo) =>
  aSettingsEvent("github_repo_removed", { repo: row.canonical });

export function settingsRepoContract(make: MakeEventfulHarness<SettingsRepo>) {
  describe("SettingsRepo contract", () => {
    let h: EventfulHarness<SettingsRepo>;
    const events = async () =>
      (await h.events.list({ limit: 50 })).map((e) => `${e.type} ${e.detail?.repo}`).toSorted();
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("starts empty", async () => {
      expect(await h.impl.listRepos()).toEqual([]);
    });

    it("adds and lists in added order", async () => {
      const b = aStoredRepo("acme/b", 2, { permissions: granted });
      const a = aStoredRepo("Acme/A", 1, { access: "unknown", permissions: null, checkedAt: null });
      expect(await h.impl.addRepo(b, { max: 50, event: onAdd })).toEqual({ ok: true, value: b });
      expect((await h.impl.addRepo(a, { max: 50, event: onAdd })).ok).toBe(true);
      expect(await h.impl.listRepos()).toEqual([a, b]);
    });

    it("rejects a case-insensitive duplicate and keeps the original", async () => {
      await h.impl.addRepo(aStoredRepo("foo/bar", 1), { max: 50, event: onAdd });
      const dup = await h.impl.addRepo(aStoredRepo("Foo/Bar", 2), { max: 50, event: onAdd });
      expect(dup).toMatchObject({ ok: false, error: { kind: "validation", field: "repo" } });
      expect((await h.impl.listRepos()).map((r) => r.canonical)).toEqual(["foo/bar"]);
    });

    it("rejects an add beyond max", async () => {
      await h.impl.addRepo(aStoredRepo("o/a", 1), { max: 2, event: onAdd });
      await h.impl.addRepo(aStoredRepo("o/b", 2), { max: 2, event: onAdd });
      const third = await h.impl.addRepo(aStoredRepo("o/c", 3), { max: 2, event: onAdd });
      expect(third).toMatchObject({ ok: false, error: { kind: "validation" } });
      expect(await h.impl.listRepos()).toHaveLength(2);
    });

    it("concurrent adds never exceed max", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          h.impl.addRepo(aStoredRepo(`o/r${i}`, i), { max: 3, event: onAdd }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(await h.impl.listRepos()).toHaveLength(3);
    });

    it("concurrent adds of one name in different cases store it once", async () => {
      const names = ["x/y", "X/y", "x/Y", "X/Y"];
      const results = await Promise.all(
        names.map((n, i) => h.impl.addRepo(aStoredRepo(n, i), { max: 50, event: onAdd })),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await h.impl.listRepos()).toHaveLength(1);
    });

    it("updates a check case-insensitively; unknown repos report false", async () => {
      await h.impl.addRepo(aStoredRepo("acme/web", 1), { max: 50, event: onAdd });
      const checkedAt = new Date(T0 + 60_000);
      expect(
        await h.impl.updateRepoCheck("ACME/WEB", {
          access: "no_access",
          permissions: null,
          checkedAt,
        }),
      ).toBe(true);
      expect(
        await h.impl.updateRepoCheck("acme/none", {
          access: "ok",
          permissions: granted,
          checkedAt,
        }),
      ).toBe(false);
      const [row] = await h.impl.listRepos();
      expect(row).toMatchObject({
        canonical: "acme/web",
        access: "no_access",
        permissions: null,
        checkedAt,
      });
      await h.impl.updateRepoCheck("acme/web", { access: "ok", permissions: granted, checkedAt });
      expect((await h.impl.listRepos())[0].permissions).toEqual(granted);
    });

    it("removes case-insensitively and returns the row once", async () => {
      const row = aStoredRepo("acme/web", 1);
      await h.impl.addRepo(row, { max: 50, event: onAdd });
      await h.impl.addRepo(aStoredRepo("acme/api", 2), { max: 50, event: onAdd });
      expect(await h.impl.removeRepo("Acme/Web", onRemove)).toEqual(row);
      expect(await h.impl.removeRepo("acme/web", onRemove)).toBeNull();
      expect((await h.impl.listRepos()).map((r) => r.canonical)).toEqual(["acme/api"]);
    });

    it("records the add and the remove events with the change", async () => {
      await h.impl.addRepo(aStoredRepo("Acme/Web", 1), { max: 50, event: onAdd });
      await h.impl.removeRepo("acme/web", onRemove);
      expect(await events()).toEqual([
        "github_repo_added Acme/Web",
        "github_repo_removed Acme/Web",
      ]);
    });

    it("a rejected add (duplicate, full) and a remove of nothing record no event", async () => {
      await h.impl.addRepo(aStoredRepo("o/a", 1), { max: 1, event: onAdd });
      await h.impl.addRepo(aStoredRepo("O/A", 2), { max: 50, event: onAdd });
      await h.impl.addRepo(aStoredRepo("o/b", 3), { max: 1, event: onAdd });
      expect(await h.impl.removeRepo("o/none", onRemove)).toBeNull();
      expect(await events()).toEqual(["github_repo_added o/a"]);
    });

    it("concurrent adds record one event per stored repo", async () => {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          h.impl.addRepo(aStoredRepo(`o/r${i}`, i), { max: 3, event: onAdd }),
        ),
      );
      const stored = (await h.impl.listRepos()).map((r) => `github_repo_added ${r.canonical}`);
      expect(await events()).toEqual(stored.toSorted());
    });

    it("a rejected event rolls the add back: the repo is not listed", async () => {
      await expect(
        h.impl.addRepo(aStoredRepo("acme/web", 1), {
          max: 50,
          event: () => aRejectedEvent("github_repo_added"),
        }),
      ).rejects.toThrow();
      expect(await h.impl.listRepos()).toEqual([]);
      expect(await events()).toEqual([]);
      // The name is free again.
      expect((await h.impl.addRepo(aStoredRepo("acme/web", 2), { max: 50, event: onAdd })).ok).toBe(
        true,
      );
    });

    it("a rejected event rolls the remove back: the repo stays listed", async () => {
      const row = aStoredRepo("acme/web", 1);
      await h.impl.addRepo(row, { max: 50, event: onAdd });
      await expect(
        h.impl.removeRepo("acme/web", () => aRejectedEvent("github_repo_removed")),
      ).rejects.toThrow();
      expect(await h.impl.listRepos()).toEqual([row]);
      expect(await events()).toEqual(["github_repo_added acme/web"]);
    });

    it("returns copies", async () => {
      await h.impl.addRepo(aStoredRepo("acme/web", 1, { permissions: granted }), {
        max: 50,
        event: onAdd,
      });
      const [a] = await h.impl.listRepos();
      a.permissions!.checks.read = "missing";
      const [b] = await h.impl.listRepos();
      expect(b.permissions!.checks.read).toBe("granted");
    });
  });
}
