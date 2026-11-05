import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Throttle } from "../../ports/throttle";
import type { ContractHarness, MakeHarness } from "./harness";

const INTERVAL = 300;

export function throttleContract(make: MakeHarness<Throttle>) {
  describe("Throttle contract", () => {
    let h: ContractHarness<Throttle>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("passes once per interval", async () => {
      expect(await h.impl.tryPass("poll", INTERVAL)).toBe(true);
      expect(await h.impl.tryPass("poll", INTERVAL)).toBe(false);
      await h.advance(INTERVAL + 100);
      expect(await h.impl.tryPass("poll", INTERVAL)).toBe(true);
      expect(await h.impl.tryPass("poll", INTERVAL)).toBe(false);
    });

    it("a blocked attempt does not extend the interval", async () => {
      await h.impl.tryPass("poll", INTERVAL);
      await h.advance(INTERVAL / 2);
      expect(await h.impl.tryPass("poll", INTERVAL)).toBe(false);
      await h.advance(INTERVAL / 2 + 50);
      expect(await h.impl.tryPass("poll", INTERVAL)).toBe(true);
    });

    it("isolates names", async () => {
      expect(await h.impl.tryPass("a", INTERVAL)).toBe(true);
      expect(await h.impl.tryPass("b", INTERVAL)).toBe(true);
    });

    it("has exactly one pass among 10 concurrent attempts", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => h.impl.tryPass("race", INTERVAL)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
}
