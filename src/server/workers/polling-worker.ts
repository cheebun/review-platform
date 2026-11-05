/**
 * A single-loop background worker: runs `tick` back to back while it reports `busy`, otherwise
 * waits for the poll interval or a WakeUp notification, whichever comes first. WakeUp is best
 * effort, the poll is the guarantee. A throwing tick is logged and backed off, never fatal.
 *
 * `stop` stops claiming new work and waits up to `graceMs` for the tick in flight. Work still
 * running after that keeps its lease and is reclaimed by another worker once the lease expires.
 */
import type { Logger } from "../../ports/system";
import type { WakeUp } from "../../ports/wake-up";

export type TickResult = "busy" | "idle";

export type PollingWorkerOptions = {
  name: string;
  pollMs: number;
  /** After a throwing tick. */
  errorBackoffMs: number;
  tick: () => Promise<TickResult>;
  logger: Logger;
  wake?: { wakeUp: WakeUp; channel: string };
};

export type PollingWorker = {
  /** Resolves once the loop exited or `graceMs` passed; idempotent. */
  stop(opts?: { graceMs?: number }): Promise<{ drained: boolean }>;
};

const DEFAULT_GRACE_MS = 10_000;

export async function startPollingWorker(opts: PollingWorkerOptions): Promise<PollingWorker> {
  const state = { stopping: false };
  let woken = false;
  let interrupt: (() => void) | null = null;

  const nudge = () => {
    woken = true;
    interrupt?.();
  };

  let unsubscribe: (() => Promise<void>) | null = null;
  if (opts.wake) {
    try {
      unsubscribe = await opts.wake.wakeUp.subscribe(opts.wake.channel, nudge);
    } catch (error) {
      // Polling still works; only latency suffers.
      opts.logger.warn("wake-up subscribe failed; polling only", {
        worker: opts.name,
        error: describe(error),
      });
    }
  }

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (state.stopping || woken) return resolve();
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        interrupt = null;
        resolve();
      }
      interrupt = done;
    });

  const loop = (async () => {
    while (!state.stopping) {
      woken = false;
      let result: TickResult;
      try {
        result = await opts.tick();
      } catch (error) {
        opts.logger.error("worker tick failed", { worker: opts.name, error: describe(error) });
        await wait(opts.errorBackoffMs);
        continue;
      }
      if (result === "idle") await wait(opts.pollMs);
    }
  })();

  let stopped: Promise<{ drained: boolean }> | null = null;
  return {
    stop({ graceMs = DEFAULT_GRACE_MS } = {}) {
      stopped ??= (async () => {
        state.stopping = true;
        interrupt?.();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), graceMs);
          timer.unref?.();
        });
        const outcome = await Promise.race([loop.then(() => "drained" as const), grace]);
        clearTimeout(timer);
        if (outcome === "timeout") {
          opts.logger.warn("worker stop grace period elapsed", { worker: opts.name, graceMs });
        }
        try {
          await unsubscribe?.();
        } catch (error) {
          opts.logger.warn("wake-up unsubscribe failed", {
            worker: opts.name,
            error: describe(error),
          });
        }
        return { drained: outcome === "drained" };
      })();
      return stopped;
    },
  };
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
