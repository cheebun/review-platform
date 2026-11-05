import type { AiReviewResult } from "../domain/review/types";
import type { DomainError, Result } from "../domain/shared/result";
import type { LlmCallOptions } from "./llm-call";

/** Everything the model sees about a pull request. All text fields are untrusted. */
export type ReviewInput = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  diffText: string;
};

export interface Reviewer {
  /**
   * Reviews one pull request. Never throws: provider failures become `upstream`, malformed or
   * partial model output becomes `validation` (fail closed, so nothing is approvable from it).
   */
  review(
    input: ReviewInput,
    options?: LlmCallOptions,
  ): Promise<Result<AiReviewResult, DomainError>>;
}

/**
 * The configured reviewer, resolved per call from the stored LLM settings (FR-LLMCFG-01):
 * `not_configured llm` when no provider is usable.
 */
export type ReviewerSource = () => Promise<Result<Reviewer>>;
