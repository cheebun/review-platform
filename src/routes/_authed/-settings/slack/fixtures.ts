import type {
  SlackChannelList,
  SlackSettingsView,
} from "../../../../application/settings/slack-settings";

/** A ready Slack section: user token verified, signing secret unverified, no app token. */
export function aSlackView(over: Partial<SlackSettingsView> = {}): SlackSettingsView {
  return {
    availability: "ready",
    secrets: {
      slack_user_token: {
        state: "set",
        last4: "AB12",
        savedAt: "2026-11-04T03:00:00.000Z",
        verifiedAt: "2026-11-04T03:00:00.000Z",
        teamName: "Acme",
        userName: "me",
      },
      slack_signing_secret: {
        state: "set",
        last4: "cdef",
        savedAt: "2026-11-04T03:00:00.000Z",
        verifiedAt: null,
      },
    },
    channels: [],
    maxChannels: 200,
    ...over,
  };
}

export function slackNotConfigured(): SlackSettingsView {
  return aSlackView({
    availability: "not_configured",
    secrets: {
      slack_user_token: { state: "unset" },
      slack_signing_secret: { state: "unset" },
    },
  });
}

export function aChannelList(over: Partial<SlackChannelList> = {}): SlackChannelList {
  return {
    channels: [
      { id: "C1AA", name: "general", isPrivate: false },
      { id: "G2BB", name: "ops-private", isPrivate: true },
      { id: "C3CC", name: "random", isPrivate: false },
    ],
    truncated: false,
    ...over,
  };
}
