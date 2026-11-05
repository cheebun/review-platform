import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoginTokenStore } from "../../ports/login-token-store";
import type { ContractHarness, MakeHarness } from "./harness";

// Shape-valid fake hashes: test vectors only, never derived from a real token.
export const HASH_A =
  "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const HASH_B =
  "pbkdf2-sha256$600000$BBBBBBBBBBBBBBBBBBBBBA$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export function loginTokenStoreContract(make: MakeHarness<LoginTokenStore>) {
  describe("LoginTokenStore contract", () => {
    let h: ContractHarness<LoginTokenStore>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("starts uninitialized", async () => {
      expect(await h.impl.isInitialized()).toBe(false);
      expect(await h.impl.getHash()).toBeNull();
    });

    it("initialize stores the hash once", async () => {
      expect(await h.impl.initialize(HASH_A)).toEqual({ ok: true, value: undefined });
      expect(await h.impl.isInitialized()).toBe(true);
      expect(await h.impl.getHash()).toBe(HASH_A);
    });

    it("a second initialize conflicts and keeps the first hash", async () => {
      await h.impl.initialize(HASH_A);
      expect(await h.impl.initialize(HASH_B)).toEqual({
        ok: false,
        error: { kind: "conflict", reason: "already initialized" },
      });
      expect(await h.impl.getHash()).toBe(HASH_A);
    });

    it("concurrent initializes: exactly one wins", async () => {
      const hashes = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? HASH_A : HASH_B));
      const results = await Promise.all(hashes.map((hash) => h.impl.initialize(hash)));
      const winners = results.flatMap((r, i) => (r.ok ? [hashes[i]] : []));
      expect(winners).toHaveLength(1);
      for (const r of results) {
        if (!r.ok) expect(r.error).toEqual({ kind: "conflict", reason: "already initialized" });
      }
      expect(await h.impl.getHash()).toBe(winners[0]);
    });

    it("rotate replaces the hash", async () => {
      await h.impl.initialize(HASH_A);
      expect(await h.impl.rotate(HASH_B)).toEqual({ ok: true, value: undefined });
      expect(await h.impl.getHash()).toBe(HASH_B);
      expect(await h.impl.isInitialized()).toBe(true);
      expect(await h.impl.rotate(HASH_A)).toEqual({ ok: true, value: undefined });
      expect(await h.impl.getHash()).toBe(HASH_A);
    });

    it("rotate fails when not initialized and creates nothing", async () => {
      expect(await h.impl.rotate(HASH_B)).toEqual({
        ok: false,
        error: { kind: "not_found", entity: "login_token" },
      });
      expect(await h.impl.isInitialized()).toBe(false);
    });

    it.each(["", "plaintext-token-0123456789abcdefghijkl", "bcrypt$x$y$z"])(
      "refuses a value that is not an encoded hash (%j)",
      async (bad) => {
        await expect(h.impl.initialize(bad)).rejects.toThrow();
        expect(await h.impl.isInitialized()).toBe(false);
        await h.impl.initialize(HASH_A);
        await expect(h.impl.rotate(bad)).rejects.toThrow();
        expect(await h.impl.getHash()).toBe(HASH_A);
      },
    );
  });
}
