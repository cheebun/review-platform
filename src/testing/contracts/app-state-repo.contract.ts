import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppStateRepo } from "../../ports/app-state-repo";
import type { ContractHarness, MakeHarness } from "./harness";

export function appStateRepoContract(make: MakeHarness<AppStateRepo>) {
  describe("AppStateRepo contract", () => {
    let h: ContractHarness<AppStateRepo>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("returns null for a missing key", async () => {
      expect(await h.impl.get("capture_since")).toBeNull();
    });

    it("setIfAbsent writes only the first time", async () => {
      expect(await h.impl.setIfAbsent("capture_since", 100)).toBe(true);
      expect(await h.impl.setIfAbsent("capture_since", 200)).toBe(false);
      expect(await h.impl.get<number>("capture_since")).toBe(100);
    });

    it("setIfAbsent has exactly one winner under concurrency", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => h.impl.setIfAbsent("k", i)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("set overwrites, including after setIfAbsent", async () => {
      await h.impl.setIfAbsent("k", 1);
      await h.impl.set("k", 2);
      expect(await h.impl.get<number>("k")).toBe(2);
      await h.impl.set("other", { a: [1, 2] });
      expect(await h.impl.get("other")).toEqual({ a: [1, 2] });
    });

    it("isolates keys and returns copies of object values", async () => {
      await h.impl.set("a", { n: 1 });
      await h.impl.set("b", { n: 2 });
      const a = await h.impl.get<{ n: number }>("a");
      a!.n = 99;
      expect(await h.impl.get("a")).toEqual({ n: 1 });
      expect(await h.impl.get("b")).toEqual({ n: 2 });
    });
  });
}
