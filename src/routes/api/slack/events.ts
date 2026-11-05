import { createFileRoute } from "@tanstack/react-router";
import { getConfig, getContainer } from "../../../server/runtime";
import { handleSlackEvents, slackServicesFor } from "../../../server/slack-features";

/**
 * Slack Events API (FR-SLACK-01). Public: authenticated by Slack's signature over the raw body,
 * checked against the signing secret stored on `/settings`. Acks at once; work runs after.
 */
export const Route = createFileRoute("/api/slack/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [{ ports }, config] = await Promise.all([getContainer(), getConfig()]);
        return handleSlackEvents(request, {
          ids: ports.ids,
          logger: ports.logger,
          services: slackServicesFor(ports, { appUrl: config.auth.url }),
        });
      },
    },
  },
});
