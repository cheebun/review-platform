import type { Clock } from "../../ports/system";
import type { Throttle } from "../../ports/throttle";

export class InMemoryThrottle implements Throttle {
  private readonly passedUntil = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async tryPass(name: string, intervalMs: number) {
    const now = this.clock.now().getTime();
    const until = this.passedUntil.get(name);
    if (until !== undefined && until > now) return false;
    this.passedUntil.set(name, now + intervalMs);
    return true;
  }
}
