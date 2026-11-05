import type { Logger } from "../../ports/system";
import type { WakeUp } from "../../ports/wake-up";
import { redactUrls } from "./client";
import type { Redis, RedisClient } from "./client";

type Entry = { handlers: Set<() => void>; ready: Promise<void> };

export class RedisWakeUp implements WakeUp {
  private subscriber: Promise<RedisClient> | undefined;
  private readonly channels = new Map<string, Entry>();
  /** Channel unsubscribes in flight, so a quick re-subscribe is ordered after them. */
  private readonly teardowns = new Map<string, Promise<void>>();
  private readonly log: Logger;

  constructor(
    private readonly redis: Redis,
    logger: Logger,
  ) {
    this.log = logger.child({ component: "redis-wake-up" });
  }

  /** Best effort: consumers also poll, so a lost message only adds latency. */
  async notify(channel: string): Promise<void> {
    try {
      await this.redis.exec((c) => c.publish(this.redis.key(channel), "1"));
    } catch (error) {
      this.log.warn("wake-up notify failed", { channel, error: describe(error) });
    }
  }

  async subscribe(channel: string, handler: () => void): Promise<() => Promise<void>> {
    const name = this.redis.key(channel);
    // One wrapper per subscription, so the same function may be subscribed twice.
    const sub = () => handler();
    let entry = this.channels.get(name);
    if (!entry) {
      const created: Entry = { handlers: new Set(), ready: Promise.resolve() };
      created.ready = this.attach(name);
      this.channels.set(name, created);
      entry = created;
    }
    entry.handlers.add(sub);
    try {
      await entry.ready;
    } catch (error) {
      this.drop(name, entry, sub);
      throw error;
    }

    let done: Promise<void> | undefined;
    return () => {
      done ??= (async () => {
        const current = this.channels.get(name);
        if (current !== entry) return;
        current.handlers.delete(sub);
        if (current.handlers.size > 0) return;
        this.channels.delete(name);
        const teardown = this.detach(name);
        this.teardowns.set(name, teardown);
        try {
          await teardown;
        } finally {
          if (this.teardowns.get(name) === teardown) this.teardowns.delete(name);
        }
      })();
      return done;
    };
  }

  private async attach(name: string): Promise<void> {
    await this.teardowns.get(name);
    const client = await this.getSubscriber();
    await client.subscribe(name, () => this.dispatch(name));
  }

  private async detach(name: string): Promise<void> {
    try {
      const client = await this.getSubscriber();
      await client.unsubscribe(name);
    } catch (error) {
      this.log.warn("wake-up unsubscribe failed", { channel: name, error: describe(error) });
    }
  }

  private drop(name: string, entry: Entry, sub: () => void): void {
    entry.handlers.delete(sub);
    if (entry.handlers.size === 0 && this.channels.get(name) === entry) this.channels.delete(name);
  }

  private getSubscriber(): Promise<RedisClient> {
    if (!this.subscriber) {
      const created = this.redis.duplicate();
      this.subscriber = created;
      // Do not cache a failed connect, so the next subscribe retries.
      created.catch(() => {
        if (this.subscriber === created) this.subscriber = undefined;
      });
    }
    return this.subscriber;
  }

  private dispatch(name: string): void {
    const entry = this.channels.get(name);
    if (!entry) return;
    for (const handler of entry.handlers) {
      try {
        const result = handler() as unknown;
        if (result instanceof Promise) {
          result.catch((error: unknown) =>
            this.log.warn("wake-up handler failed", { channel: name, error: describe(error) }),
          );
        }
      } catch (error) {
        this.log.warn("wake-up handler failed", { channel: name, error: describe(error) });
      }
    }
  }
}

function describe(error: unknown): string {
  return redactUrls(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}
