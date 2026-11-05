import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RateLimiter } from "../../ports/rate-limiter";
import type { ContractHarness, MakeHarness } from "./harness";

const opts = { limit: 3, windowMs: 400 };

export function rateLimiterContract(make: MakeHarness<RateLimiter>) {
  describe("RateLimiter contract", () => {
    let h: ContractHarness<RateLimiter>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("allows `limit` hits with a decreasing remaining count, then blocks", async () => {
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await h.impl.hit("llm:u1", opts));
      expect(results.slice(0, 3).map((r) => [r.allowed, r.remaining])).toEqual([
        [true, 2],
        [true, 1],
        [true, 0],
      ]);
      expect(results[3]!.allowed).toBe(false);
      expect(results[3]!.remaining).toBe(0);
      expect(results[3]!.retryAfterMs).toBeGreaterThan(0);
      expect(results[3]!.retryAfterMs).toBeLessThanOrEqual(opts.windowMs);
    });

    it("allows again after the window", async () => {
      for (let i = 0; i < 3; i++) await h.impl.hit("k", opts);
      expect((await h.impl.hit("k", opts)).allowed).toBe(false);
      await h.advance(opts.windowMs + 100);
      expect((await h.impl.hit("k", opts)).allowed).toBe(true);
    });

    it("slides: only hits that left the window are forgotten", async () => {
      await h.impl.hit("k", opts); // t0
      await h.advance(250);
      await h.impl.hit("k", opts); // t0+250
      await h.impl.hit("k", opts); // t0+250
      expect((await h.impl.hit("k", opts)).allowed).toBe(false);
      await h.advance(200); // t0+450: the first hit expired, the other two did not
      const r = await h.impl.hit("k", opts);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(0);
      expect((await h.impl.hit("k", opts)).allowed).toBe(false);
    });

    it("blocked hits are not counted against the window", async () => {
      for (let i = 0; i < 3; i++) await h.impl.hit("k", opts);
      for (let i = 0; i < 5; i++) await h.impl.hit("k", opts);
      await h.advance(opts.windowMs + 100);
      const r = await h.impl.hit("k", opts);
      expect([r.allowed, r.remaining]).toEqual([true, 2]);
    });

    it("isolates keys", async () => {
      for (let i = 0; i < 3; i++) await h.impl.hit("a", opts);
      expect((await h.impl.hit("a", opts)).allowed).toBe(false);
      expect((await h.impl.hit("b", opts)).allowed).toBe(true);
    });

    it("never allows more than `limit` among concurrent hits", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => h.impl.hit("race", opts)));
      expect(results.filter((r) => r.allowed)).toHaveLength(opts.limit);
    });
  });
}
