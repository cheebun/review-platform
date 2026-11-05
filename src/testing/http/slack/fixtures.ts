/** Minimal real-shaped Slack Web API responses. Fake ids and tokens only. */
export const SLACK_TEAM_URL = "https://acme.slack.com/";

export const authTestOk = {
  ok: true,
  url: SLACK_TEAM_URL,
  team: "Acme",
  user: "me",
  team_id: "T1",
  user_id: "U1",
};

export const platformError = (error: string) => ({ ok: false, error });
