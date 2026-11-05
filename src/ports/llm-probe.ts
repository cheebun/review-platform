import type { LlmProbeOutcome, LlmTarget } from "../domain/settings/llm-settings";

/**
 * The probe on save: one minimal request against `target` with a timeout, the same as
 * `pnpm llm:ping` (`probeLlm` in `adapters/llm/ping.ts`). Never throws.
 */
export type LlmProbe = (target: LlmTarget) => Promise<LlmProbeOutcome>;
