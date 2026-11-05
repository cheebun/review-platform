/**
 * The review job consumer process loop (architecture §5): woken by `review-job:wake`, polls as
 * a fallback, processes one job per tick under a lease. When idle it runs the result-reply
 * backstop at most every `backstopMs`.
 */
import { REVIEW_JOB_WAKE_CHANNEL } from "../../application/review/ports";
import {
  processNextReviewJob,
  sendPendingResultReplies,
  type ReviewConsumerDeps,
} from "../../application/review/review-job-consumer";
import type { WakeUp } from "../../ports/wake-up";
import { startPollingWorker, type PollingWorker } from "./polling-worker";

export type ReviewJobConsumerWorkerOptions = {
  deps: ReviewConsumerDeps;
  /** Lease owner id, unique per process (e.g. hostname + pid + random). */
  owner: string;
  wakeUp?: WakeUp;
  pollMs?: number;
  errorBackoffMs?: number;
  backstopMs?: number;
};

export async function startReviewJobConsumer(
  opts: ReviewJobConsumerWorkerOptions,
): Promise<PollingWorker> {
  const { deps } = opts;
  const backstopMs = opts.backstopMs ?? 60_000;
  let lastBackstop = Number.NEGATIVE_INFINITY;
  return startPollingWorker({
    name: "review-job-consumer",
    pollMs: opts.pollMs ?? 5_000,
    errorBackoffMs: opts.errorBackoffMs ?? 10_000,
    logger: deps.logger,
    ...(opts.wakeUp ? { wake: { wakeUp: opts.wakeUp, channel: REVIEW_JOB_WAKE_CHANNEL } } : {}),
    tick: async () => {
      const out = await processNextReviewJob(deps, opts.owner);
      if (out.kind !== "idle") return "busy";
      const now = deps.clock.now().getTime();
      if (now - lastBackstop >= backstopMs) {
        lastBackstop = now;
        await sendPendingResultReplies(deps);
      }
      return "idle";
    },
  });
}
