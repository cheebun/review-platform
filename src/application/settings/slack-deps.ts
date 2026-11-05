import type { RateLimiter } from "../../ports/rate-limiter";
import type { SettingsStore } from "../../ports/settings-store";
import type { SlackVerifier } from "../../ports/slack-verifier";
import type { Clock, IdGenerator, Logger } from "../../ports/system";
import type { WakeUp } from "../../ports/wake-up";

/** The ports the Slack settings use cases need. Field names match the container's `Ports`. */
export interface SlackSettingsDeps {
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  rateLimiter: RateLimiter;
  settingsStore: SettingsStore;
  slackVerifier: SlackVerifier;
  /** Publishes `SLACK_SETTINGS_CHANGED_CHANNEL` after a secret is saved or removed. */
  wakeUp: WakeUp;
}
