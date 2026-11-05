import type { EventDedupe } from "../../ports/event-dedupe";
import type { Redis } from "./client";
import { assertPositiveInt } from "./validate";

export class RedisEventDedupe implements EventDedupe {
  constructor(private readonly redis: Redis) {}

  /** SET NX PX. Errors propagate: an unconfirmed claim is never reported as won. */
  async claim(eventId: string, ttlMs: number): Promise<boolean> {
    assertPositiveInt("ttlMs", ttlMs);
    const key = this.redis.key(`slack:event:${eventId}`);
    const reply = await this.redis.exec((c) =>
      c.set(key, "1", { condition: "NX", expiration: { type: "PX", value: ttlMs } }),
    );
    return reply === "OK";
  }
}
