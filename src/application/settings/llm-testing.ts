import type { LlmProbeOutcome, LlmTarget } from "../../domain/settings/llm-settings";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { InMemoryRateLimiter } from "../../testing/fakes/in-memory-rate-limiter";
import { InMemoryReviewEventRepo } from "../../testing/fakes/in-memory-review-event-repo";
import { InMemorySettingsStore } from "../../testing/fakes/in-memory-settings-store";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { SequenceIdGenerator } from "../../testing/fakes/sequence-id-generator";
import type { LlmProbe, LlmSettingsDeps } from "./llm-deps";

// Test sentinels, never real credentials.
export const ANTHROPIC_KEY = "test-anthropic-app-key-0000-AK01";
export const ANTHROPIC_KEY_2 = "test-anthropic-app-key-0000-AK02";
export const ANTHROPIC_TOKEN = "test-anthropic-app-token-000-AT01";
export const OPENAI_KEY = "test-openai-app-key-000000-OK01";
export const LLM_NOW = new Date("2026-11-04T03:00:00.000Z");
export const GATEWAY = "https://gateway.example.test";
export const RELAY = "https://relay.example.test/v1";

/**
 * The LLM settings use cases over fakes. The probe answers `ok` (with the target's model)
 * unless `answerProbe` scripted another outcome; pass `probe` to use a real one instead (the
 * functions tests pass the adapter's `probeLlm` behind msw). Every target is recorded.
 */
export function llmSettingsSetup(probe?: LlmProbe) {
  const clock = new FakeClock(LLM_NOW);
  const reviewEvents = new InMemoryReviewEventRepo();
  const settingsStore = new InMemorySettingsStore(reviewEvents);
  const logger = new MemoryLogger();
  const probes: LlmTarget[] = [];
  let scripted: LlmProbeOutcome | null = null;
  const answerProbe = (outcome: LlmProbeOutcome) => {
    scripted = outcome;
  };
  const deps: LlmSettingsDeps = {
    clock,
    ids: new SequenceIdGenerator(),
    logger,
    rateLimiter: new InMemoryRateLimiter(clock),
    settingsStore,
    llmProbe: async (target) => {
      probes.push(structuredClone(target));
      if (probe) return probe(target);
      return scripted ?? { kind: "ok", latencyMs: 42, model: target.model };
    },
  };
  return { deps, clock, reviewEvents, settingsStore, logger, probes, answerProbe };
}
