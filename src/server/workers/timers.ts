/** Real `Timers`. Every timer is unref'd so a pending deadline never keeps the process alive. */
import type { Timers } from "../../application/review/ports";

export const realTimers: Timers = {
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms)).unref?.();
    }),
  deadline: (ms) => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, Math.max(0, ms));
      handle.unref?.();
    });
    return { done, cancel: () => clearTimeout(handle) };
  },
};
