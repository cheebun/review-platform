import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptLimiter, AttemptPolicy } from "../../ports/attempt-limiter";
import type { ContractHarness, MakeHarness } from "./harness";

const POLICY: AttemptPolicy = { limit: 3, windowMs: 400, lockoutMs: 800 };

export function attemptLimiterContract(make: MakeHarness<AttemptLimiter>) {
  describe("AttemptLimiter contract", () => {
    let h: ContractHarness<AttemptLimiter>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    const attempt = (key = "ip:1") => h.impl.attempt(key, POLICY);

    it("allows `limit` attempts, then refuses with the time left", async () => {
      for (let i = 0; i < POLICY.limit; i++) {
        expect(await attempt()).toEqual({ allowed: true, retryAfterMs: 0 });
      }
      const refused = await attempt();
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterMs).toBeGreaterThan(0);
      expect(refused.retryAfterMs).toBeLessThanOrEqual(POLICY.lockoutMs);
    });

    it("keeps the key locked for the lockout, even past the window, and refusals do not extend it", async () => {
      for (let i = 0; i < POLICY.limit; i++) await attempt();
      await h.advance(POLICY.windowMs + 100);
      const first = await attempt();
      expect(first.allowed).toBe(false);
      await h.advance(100);
      const second = await attempt();
      expect(second.allowed).toBe(false);
      expect(second.retryAfterMs).toBeLessThan(first.retryAfterMs);
      await h.advance(POLICY.lockoutMs - POLICY.windowMs);
      expect((await attempt()).allowed).toBe(true);
    });

    it("forgets attempts once the window has passed without a lockout", async () => {
      for (let i = 0; i < POLICY.limit - 1; i++) await attempt();
      await h.advance(POLICY.windowMs + 100);
      for (let i = 0; i < POLICY.limit; i++) expect((await attempt()).allowed).toBe(true);
      expect((await attempt()).allowed).toBe(false);
    });

    it("reset forgets the attempts and ends a lockout", async () => {
      for (let i = 0; i < POLICY.limit; i++) await attempt();
      expect((await attempt()).allowed).toBe(false);
      await h.impl.reset("ip:1");
      for (let i = 0; i < POLICY.limit; i++) expect((await attempt()).allowed).toBe(true);
    });

    it("reset of an unknown key is a no-op", async () => {
      await expect(h.impl.reset("never-seen")).resolves.toBeUndefined();
    });

    it("isolates keys", async () => {
      for (let i = 0; i < POLICY.limit; i++) await attempt("ip:a");
      expect((await attempt("ip:a")).allowed).toBe(false);
      expect((await attempt("ip:b")).allowed).toBe(true);
    });

    it("allows exactly `limit` of 10 concurrent attempts", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => attempt("race")));
      expect(results.filter((r) => r.allowed)).toHaveLength(POLICY.limit);
    });
  });
}
