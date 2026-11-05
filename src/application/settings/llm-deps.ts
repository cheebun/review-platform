import type { LlmProbe } from "../../ports/llm-probe";
import type { RateLimiter } from "../../ports/rate-limiter";
import type { SettingsStore } from "../../ports/settings-store";
import type { Clock, IdGenerator, Logger } from "../../ports/system";

export type { LlmProbe } from "../../ports/llm-probe";

/** The ports the LLM settings use cases need. Field names match the container's `Ports`. */
export interface LlmSettingsDeps {
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  rateLimiter: RateLimiter;
  settingsStore: SettingsStore;
  llmProbe: LlmProbe;
}
