import type { Throttle } from "../../ports/throttle";
import type { Redis } from "./client";
import { assertPositiveInt } from "./validate";

export class RedisThrottle implements Throttle {
  constructor(private readonly redis: Redis) {}

  async tryPass(name: string, intervalMs: number): Promise<boolean> {
    assertPositiveInt("intervalMs", intervalMs);
    const key = this.redis.key(`throttle:${name}`);
    const reply = await this.redis.exec((c) =>
      c.set(key, "1", { condition: "NX", expiration: { type: "PX", value: intervalMs } }),
    );
    return reply === "OK";
  }
}
