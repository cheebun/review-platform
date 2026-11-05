import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WakeUp } from "../../ports/wake-up";
import type { ContractHarness, MakeHarness } from "./harness";
import { sleep, waitUntil } from "./harness";

export function wakeUpContract(make: MakeHarness<WakeUp>) {
  describe("WakeUp contract", () => {
    let h: ContractHarness<WakeUp>;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    it("delivers a notification to a subscriber", async () => {
      let calls = 0;
      const off = await h.impl.subscribe("review-job:wake", () => void (calls += 1));
      await h.impl.notify("review-job:wake");
      await waitUntil(() => calls === 1);
      await off();
    });

    it("stops delivery after unsubscribe", async () => {
      let calls = 0;
      const off = await h.impl.subscribe("review-job:wake", () => void (calls += 1));
      await h.impl.notify("review-job:wake");
      await waitUntil(() => calls === 1);
      await off();
      await h.impl.notify("review-job:wake");
      await sleep(100);
      expect(calls).toBe(1);
    });

    it("delivers to every subscriber, and unsubscribing one leaves the others", async () => {
      let a = 0;
      let b = 0;
      const offA = await h.impl.subscribe("c", () => void (a += 1));
      const offB = await h.impl.subscribe("c", () => void (b += 1));
      await h.impl.notify("c");
      await waitUntil(() => a === 1 && b === 1);
      await offA();
      await h.impl.notify("c");
      await waitUntil(() => b === 2);
      await sleep(50);
      expect(a).toBe(1);
      await offB();
    });

    it("does not deliver across channels", async () => {
      let calls = 0;
      const off = await h.impl.subscribe("one", () => void (calls += 1));
      await h.impl.notify("two");
      await sleep(100);
      expect(calls).toBe(0);
      await off();
    });

    it("a throwing handler does not break notify or other subscribers", async () => {
      let ok = 0;
      const offBad = await h.impl.subscribe("c", () => {
        throw new Error("boom");
      });
      const offOk = await h.impl.subscribe("c", () => void (ok += 1));
      await expect(h.impl.notify("c")).resolves.toBeUndefined();
      await waitUntil(() => ok === 1);
      await offBad();
      await offOk();
    });
  });
}
