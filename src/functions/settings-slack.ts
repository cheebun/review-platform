import { createServerFn } from "@tanstack/react-start";
import { authed } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import {
  loadSlackSettings,
  parseSlackChannelsBody,
  parseSlackSecretBody,
  parseSlackSecretKindBody,
  runListSlackChannels,
  runRemoveSlackSecret,
  runSaveSlackSecret,
  runSetSlackChannels,
  type SlackFnPorts,
} from "./settings-slack.logic";

const slackPorts = async (): Promise<SlackFnPorts> => (await getContainer()).ports;

/** The Slack section model: status and last 4 of each secret, and the channel selection. */
export const fetchSlackSettings = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async ({ context }) => loadSlackSettings(await slackPorts(), context.actor));

/** Checks the value (format, then Slack where possible), then stores it encrypted. */
export const saveSlackSecretFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseSlackSecretBody)
  .handler(async ({ data, context }) =>
    runSaveSlackSecret(await slackPorts(), context.actor, data),
  );

export const removeSlackSecretFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseSlackSecretKindBody)
  .handler(async ({ data, context }) =>
    runRemoveSlackSecret(await slackPorts(), context.actor, data),
  );

/** The channels the stored user token is a member of, for the picker. */
export const listSlackChannelsFn = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async ({ context }) => runListSlackChannels(await slackPorts(), context.actor));

/** Replaces the review-channel selection. Empty: all channels. */
export const setSlackChannelsFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseSlackChannelsBody)
  .handler(async ({ data, context }) =>
    runSetSlackChannels(await slackPorts(), context.actor, data),
  );
