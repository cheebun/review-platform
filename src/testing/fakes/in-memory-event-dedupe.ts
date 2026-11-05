import type { EventDedupe } from "../../ports/event-dedupe";
import type { Clock } from "../../ports/system";

export class InMemoryEventDedupe implements EventDedupe {
  private readonly expiry = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async claim(eventId: string, ttlMs: number) {
    const now = this.clock.now().getTime();
    const until = this.expiry.get(eventId);
    if (until !== undefined && until > now) return false;
    this.expiry.set(eventId, now + ttlMs);
    return true;
  }
}
