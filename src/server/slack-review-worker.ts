/** Review consumer and reaction outbox loops for HTTP Events API ingestion. */
import type { Ports } from "./container";
import type { SlackServices } from "./slack-features";
import { startReactionOutboxDrainer } from "./workers/reaction-outbox-drainer";
import { startReviewJobConsumer } from "./workers/review-job-consumer";

export type SlackReviewWorkerOptions = {
  ports: Ports;
  services: SlackServices;
  /** Lease owner id, unique per process. */
  owner: string;
  /** Called with each loop's name once it runs (observability and tests). */
  onStarted?: (name: string) => void;
};

export type SlackReviewWorker = {
  /** Stop both work loops and drain running work within `graceMs`. */
  stop(opts?: { graceMs?: number }): Promise<{ consumerDrained: boolean; outboxDrained: boolean }>;
};

export async function startSlackReviewWorker(
  opts: SlackReviewWorkerOptions,
): Promise<SlackReviewWorker> {
  const { ports, services, owner } = opts;

  const consumer = await startReviewJobConsumer({
    deps: services.consumer,
    owner,
    wakeUp: ports.wakeUp,
  });
  opts.onStarted?.("review-job-consumer");
  const drainer = await startReactionOutboxDrainer({ deps: services.reactions, owner });
  opts.onStarted?.("reaction-outbox-drainer");

  let stopped: ReturnType<SlackReviewWorker["stop"]> | undefined;
  return {
    stop: ({ graceMs }: { graceMs?: number } = {}) => {
      stopped ??= (async () => {
        const [consumed, drained] = await Promise.all([
          consumer.stop({ graceMs }),
          drainer.stop({ graceMs }),
        ]);
        return { consumerDrained: consumed.drained, outboxDrained: drained.drained };
      })();
      return stopped;
    },
  };
}
