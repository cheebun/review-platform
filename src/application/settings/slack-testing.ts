import type { SlackChannel } from "../../ports/slack";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { FakeSlackVerifier } from "../../testing/fakes/fake-slack-verifier";
import { InMemoryRateLimiter } from "../../testing/fakes/in-memory-rate-limiter";
import { InMemoryReviewEventRepo } from "../../testing/fakes/in-memory-review-event-repo";
import { InMemorySettingsStore } from "../../testing/fakes/in-memory-settings-store";
import { InMemoryWakeUp } from "../../testing/fakes/in-memory-wake-up";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { SequenceIdGenerator } from "../../testing/fakes/sequence-id-generator";
import type { SlackSettingsDeps } from "./slack-deps";

// Test sentinels, never real credentials.
export const USER_TOKEN = "xoxp-0000-FAKE-app-user-token-0001";
export const USER_TOKEN_2 = "xoxp-0000-FAKE-app-user-token-0002";
export const BOT_LIKE_USER_TOKEN = "xoxp-0000-FAKE-app-bot-identity-0003";
export const APP_TOKEN = "xapp-1-AFAKE-0000-app-level-token-0004";
export const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
export const SLACK_NOW = new Date("2026-11-04T03:00:00.000Z");

export const channel = (id: string, name: string, extra: Partial<SlackChannel> = {}) => ({
  id,
  name,
  isPrivate: false,
  isArchived: false,
  isMember: true,
  ...extra,
});

export function slackSettingsSetup() {
  const clock = new FakeClock(SLACK_NOW);
  const reviewEvents = new InMemoryReviewEventRepo();
  const settingsStore = new InMemorySettingsStore(reviewEvents);
  const slackVerifier = new FakeSlackVerifier();
  const logger = new MemoryLogger();
  const wakeUp = new InMemoryWakeUp(clock);
  slackVerifier.userToken(USER_TOKEN);
  slackVerifier.userToken(USER_TOKEN_2, { userId: "U2", userName: "other" });
  slackVerifier.botToken(BOT_LIKE_USER_TOKEN);
  const deps: SlackSettingsDeps = {
    clock,
    ids: new SequenceIdGenerator(),
    logger,
    rateLimiter: new InMemoryRateLimiter(clock),
    settingsStore,
    slackVerifier,
    wakeUp,
  };
  return { deps, clock, reviewEvents, settingsStore, slackVerifier, logger, wakeUp };
}
