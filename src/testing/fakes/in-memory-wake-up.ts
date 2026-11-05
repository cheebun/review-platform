import type { Clock } from "../../ports/system";
import type { WakeUp } from "../../ports/wake-up";

/** Delivers on a later microtask, like a real pub/sub, and isolates handler errors. */
export class InMemoryWakeUp implements WakeUp {
  private readonly subs = new Map<string, Set<{ handler: () => void }>>();

  constructor(private readonly clock: Clock) {
    void this.clock;
  }

  async notify(channel: string) {
    for (const sub of this.subs.get(channel) ?? []) {
      queueMicrotask(() => {
        // Skip when unsubscribed between notify and delivery.
        if (!this.subs.get(channel)?.has(sub)) return;
        try {
          sub.handler();
        } catch {
          // Best effort: a failing handler never affects other subscribers.
        }
      });
    }
  }

  async subscribe(channel: string, handler: () => void) {
    const sub = { handler };
    const set = this.subs.get(channel) ?? new Set();
    set.add(sub);
    this.subs.set(channel, set);
    return async () => {
      set.delete(sub);
    };
  }
}
