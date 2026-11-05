import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventDedupe } from "../../ports/event-dedupe";
import type { ContractHarness, MakeHarness } from "./harness";

const TTL = 300;

export function eventDedupeContract(make: MakeHarness<EventDedupe>) {
  describe("EventDedupe contract", () => {
    let h: ContractHarness<EventDedupe>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("first claim is true, second is false", async () => {
      expect(await h.impl.claim("Ev1", TTL)).toBe(true);
      expect(await h.impl.claim("Ev1", TTL)).toBe(false);
    });

    it("different ids are independent", async () => {
      expect(await h.impl.claim("Ev1", TTL)).toBe(true);
      expect(await h.impl.claim("Ev2", TTL)).toBe(true);
    });

    it("is true again after the TTL", async () => {
      await h.impl.claim("Ev1", TTL);
      await h.advance(TTL + 100);
      expect(await h.impl.claim("Ev1", TTL)).toBe(true);
    });

    it("a rejected claim does not extend the TTL", async () => {
      await h.impl.claim("Ev1", TTL);
      await h.advance(TTL / 2);
      expect(await h.impl.claim("Ev1", TTL)).toBe(false);
      await h.advance(TTL / 2 + 50);
      expect(await h.impl.claim("Ev1", TTL)).toBe(true);
    });

    it("has exactly one true among 10 concurrent claims of the same id", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => h.impl.claim("race", TTL)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
}
