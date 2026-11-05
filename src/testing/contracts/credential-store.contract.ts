import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialStore, CredentialWrite } from "../../ports/credential-store";
import {
  aRejectedEvent,
  aSettingsEvent,
  type EventfulHarness,
  type MakeEventfulHarness,
} from "./harness";

const T0 = new Date("2026-11-04T01:00:00.000Z");

export const aCredentialWrite = (
  n: number,
  over: Partial<CredentialWrite> = {},
): CredentialWrite => ({
  encrypted: { ciphertext: `Y2lwaGVy${n}`, iv: `aXY${n}`, authTag: `dGFn${n}`, keyVersion: 1 },
  login: `user${n}`,
  avatarUrl: `https://avatars.example.test/u/${n}`,
  last4: `00${n}`.slice(-4),
  tokenKind: "fine_grained",
  scopes: null,
  savedAt: new Date(T0.getTime() + n * 1000),
  savedByUserId: "owner-1",
  ...over,
});

/** Event builders for `save` and `remove`, as the use cases pass them. */
const onSave = ({ replaced }: { replaced: boolean }) =>
  aSettingsEvent(replaced ? "github_token_replaced" : "github_token_saved");
const onRemove = (meta: { login: string; last4: string }) =>
  aSettingsEvent("github_token_removed", { login: meta.login, last4: meta.last4 });

export function credentialStoreContract(make: MakeEventfulHarness<CredentialStore>) {
  describe("CredentialStore contract", () => {
    let h: EventfulHarness<CredentialStore>;
    const types = async () => (await h.events.list({ limit: 50 })).map((e) => e.type);
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("is empty at first", async () => {
      expect(await h.impl.get()).toBeNull();
      expect(await h.impl.remove(onRemove)).toBeNull();
    });

    it("saves, then reads back the ciphertext and the metadata", async () => {
      const w = aCredentialWrite(1, { tokenKind: "classic", scopes: ["repo", "read:user"] });
      const saved = await h.impl.save(w, onSave);
      expect(saved.replaced).toBe(false);
      expect(saved.meta).toEqual({
        login: "user1",
        avatarUrl: w.avatarUrl,
        last4: w.last4,
        savedAt: w.savedAt,
        savedByUserId: "owner-1",
        tokenKind: "classic",
        scopes: ["repo", "read:user"],
        version: 1,
      });
      expect(await h.impl.get()).toEqual({ encrypted: w.encrypted, meta: saved.meta });
    });

    it("a second save replaces the row and bumps the version", async () => {
      await h.impl.save(aCredentialWrite(1), onSave);
      const second = await h.impl.save(aCredentialWrite(2), onSave);
      expect(second.replaced).toBe(true);
      expect(second.meta.version).toBe(2);
      const row = await h.impl.get();
      expect(row?.meta.login).toBe("user2");
      expect(row?.encrypted).toEqual(aCredentialWrite(2).encrypted);
    });

    it("concurrent saves are serialised: one insert, the rest replace, one row remains", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => h.impl.save(aCredentialWrite(i + 1), onSave)),
      );
      expect(results.filter((r) => !r.replaced)).toHaveLength(1);
      expect(results.map((r) => r.meta.version).toSorted((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      const row = await h.impl.get();
      const last = results.find((r) => r.meta.version === 8)!;
      expect(row?.meta).toEqual(last.meta);
    });

    it("remove deletes the row and returns it; a later save starts again", async () => {
      await h.impl.save(aCredentialWrite(1), onSave);
      const removed = await h.impl.remove(onRemove);
      expect(removed?.login).toBe("user1");
      expect(await h.impl.get()).toBeNull();
      expect(await h.impl.remove(onRemove)).toBeNull();
      const again = await h.impl.save(aCredentialWrite(3), onSave);
      expect(again).toMatchObject({ replaced: false, meta: { version: 1, login: "user3" } });
    });

    it("records each write's event with it, built from the outcome", async () => {
      await h.impl.save(aCredentialWrite(1), onSave);
      await h.impl.save(aCredentialWrite(2), onSave);
      await h.impl.remove(onRemove);
      expect((await types()).toSorted()).toEqual([
        "github_token_removed",
        "github_token_replaced",
        "github_token_saved",
      ]);
      const [removed] = await h.events.list({ types: ["github_token_removed"], limit: 1 });
      expect(removed.detail).toEqual({ login: "user2", last4: aCredentialWrite(2).last4 });
    });

    it("concurrent saves record exactly one saved event and one replaced event per other save", async () => {
      await Promise.all(
        Array.from({ length: 4 }, (_, i) => h.impl.save(aCredentialWrite(i + 1), onSave)),
      );
      expect((await types()).toSorted()).toEqual([
        "github_token_replaced",
        "github_token_replaced",
        "github_token_replaced",
        "github_token_saved",
      ]);
    });

    it("removing nothing records no event", async () => {
      expect(await h.impl.remove(onRemove)).toBeNull();
      expect(await types()).toEqual([]);
    });

    it("a rejected event rolls the first save back: nothing is stored", async () => {
      await expect(
        h.impl.save(aCredentialWrite(1), () => aRejectedEvent("github_token_saved")),
      ).rejects.toThrow();
      expect(await h.impl.get()).toBeNull();
      expect(await types()).toEqual([]);
    });

    it("a rejected event rolls a replacement back: the old credential stays", async () => {
      await h.impl.save(aCredentialWrite(1), onSave);
      const before = await h.impl.get();
      await expect(
        h.impl.save(aCredentialWrite(2), () => aRejectedEvent("github_token_replaced")),
      ).rejects.toThrow();
      expect(await h.impl.get()).toEqual(before);
      expect(await types()).toEqual(["github_token_saved"]);
      // The rolled-back write did not consume a version.
      expect((await h.impl.save(aCredentialWrite(3), onSave)).meta.version).toBe(2);
    });

    it("a rejected event rolls the remove back: the credential stays", async () => {
      await h.impl.save(aCredentialWrite(1), onSave);
      const before = await h.impl.get();
      await expect(h.impl.remove(() => aRejectedEvent("github_token_removed"))).rejects.toThrow();
      expect(await h.impl.get()).toEqual(before);
      expect(await types()).toEqual(["github_token_saved"]);
    });

    it("returns copies", async () => {
      await h.impl.save(aCredentialWrite(1, { tokenKind: "classic", scopes: ["repo"] }), onSave);
      const a = await h.impl.get();
      a!.meta.scopes!.push("admin");
      a!.encrypted.ciphertext = "changed";
      const b = await h.impl.get();
      expect(b?.meta.scopes).toEqual(["repo"]);
      expect(b?.encrypted.ciphertext).toBe(aCredentialWrite(1).encrypted.ciphertext);
    });
  });
}
