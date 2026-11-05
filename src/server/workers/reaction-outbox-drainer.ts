/**
 * The reaction outbox drainer process loop (FR-SLACK-08): drains due ops while there are any,
 * then polls. Only touches the outbox and Slack reactions, never a review result.
 */
import {
  drainReactionOutbox,
  type ReactionDrainDeps,
} from "../../application/review/reaction-drain";
import { startPollingWorker, type PollingWorker } from "./polling-worker";

export type ReactionOutboxDrainerOptions = {
  deps: ReactionDrainDeps;
  owner: string;
  pollMs?: number;
  errorBackoffMs?: number;
};

export async function startReactionOutboxDrainer(
  opts: ReactionOutboxDrainerOptions,
): Promise<PollingWorker> {
  return startPollingWorker({
    name: "reaction-outbox-drainer",
    pollMs: opts.pollMs ?? 2_000,
    errorBackoffMs: opts.errorBackoffMs ?? 10_000,
    logger: opts.deps.logger,
    tick: async () => {
      const report = await drainReactionOutbox(opts.deps, opts.owner);
      return report.applied > 0 ? "busy" : "idle";
    },
  });
}
