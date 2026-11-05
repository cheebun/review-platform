import { WebClient, LogLevel } from "@slack/web-api";
import { GITHUB_ACCOUNTS, tokenEnvKey, type GithubAccount } from "./accounts";
import { SLACK_REVIEW_ACTIVE_HOURS } from "./slack-review-rules";
import { defaultSlackShip, type RunnerDependencies } from "./slack-review-runner";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}。`);
  return value;
}

/** Shared by the Socket Mode worker and the Vercel Events API route. */
export function readSlackReviewConfig() {
  const userToken = required("SLACK_USER_TOKEN");
  const account = (process.env.SLACK_REVIEW_GITHUB_ACCOUNT?.trim() ||
    "zhiyong-eng") as GithubAccount;
  if (!(GITHUB_ACCOUNTS as readonly string[]).includes(account))
    throw new Error("SLACK_REVIEW_GITHUB_ACCOUNT 必须是 zhiyong-eng 或 wgbx。");
  required(tokenEnvKey(account));
  if (
    !process.env.OPENAI_API_KEY?.trim() &&
    !process.env.ANTHROPIC_AUTH_TOKEN?.trim() &&
    !process.env.ANTHROPIC_API_KEY?.trim()
  ) {
    throw new Error("缺少 AI 凭证（Anthropic 或 OPENAI_API_KEY）。");
  }
  const channelIds = process.env.SLACK_REVIEW_CHANNEL_IDS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return { userToken, account, channelIds, activeHours: SLACK_REVIEW_ACTIVE_HOURS };
}

export type SlackReviewConfig = ReturnType<typeof readSlackReviewConfig>;

export function createSlackClient(config: SlackReviewConfig) {
  return new WebClient(config.userToken, { logLevel: LogLevel.ERROR });
}

export async function fetchSlackIdentity(slack: WebClient) {
  const auth = await slack.auth.test();
  if (!auth.user_id || !auth.team_id || auth.bot_id) {
    throw new Error("SLACK_USER_TOKEN 必须是你的用户授权，才能处理发给你的私信和以你的身份加 ✅。");
  }
  return {
    userId: auth.user_id,
    teamId: auth.team_id,
    teamUrl: auth.url ?? "",
    userName: auth.user ?? "",
  };
}

export function slackReviewDependencies(
  config: SlackReviewConfig,
  slack: WebClient,
): RunnerDependencies {
  return {
    reply: async (channel, ts, threadTs, text = "on it") => {
      await slack.chat.postMessage({ channel, thread_ts: threadTs ?? ts, text });
    },
    ship: defaultSlackShip,
    react: async (channel, ts) => {
      try {
        await slack.reactions.add({ channel, timestamp: ts, name: "white_check_mark" });
      } catch (error) {
        const code = (error as { data?: { error?: string } }).data?.error;
        if (code !== "already_reacted") throw error;
      }
    },
  };
}
