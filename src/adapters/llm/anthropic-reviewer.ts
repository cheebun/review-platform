import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import { toAiReviewResult } from "../../domain/review/review";
import type { AiReviewResult } from "../../domain/review/types";
import type { ReviewInput, Reviewer } from "../../ports/reviewer";
import { AnthropicStructured, type AnthropicMessageParam } from "./anthropic-structured";
import { parseJsonText } from "./json";
import type { AnthropicAdapterOptions, LlmCallOptions } from "./options";
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "./review-prompt";
import { REVIEW_JSON_SCHEMA } from "./review-schema";

const CORRECTION =
  "The review output failed schema validation. Submit the complete review again as a single JSON object that matches the output schema. summary must be a non-empty string. findings must be an actual JSON array of complete finding objects, not a string containing JSON. Escape quotes inside strings correctly. Preserve every finding; do not remove issues to satisfy the schema.";

/** Review is correctness-sensitive, so it defaults to the highest everyday effort. */
export const REVIEW_DEFAULT_EFFORT = "high";

export class AnthropicReviewer implements Reviewer {
  private readonly llm: AnthropicStructured;

  constructor(options: AnthropicAdapterOptions) {
    this.llm = new AnthropicStructured(options, REVIEW_DEFAULT_EFFORT);
  }

  async review(
    input: ReviewInput,
    options: LlmCallOptions = {},
  ): Promise<Result<AiReviewResult, DomainError>> {
    const messages: AnthropicMessageParam[] = [
      { role: "user", content: buildReviewPrompt(input, "structured") },
    ];
    for (let attempt = 0; ; attempt++) {
      const called = await this.llm.call(
        {
          system: REVIEW_SYSTEM_PROMPT,
          messages,
          schema: REVIEW_JSON_SCHEMA,
        },
        options,
      );
      if (!called.ok) return err(called.error);

      const parsed = parseJsonText(called.value);
      const result = parsed.ok ? toAiReviewResult(parsed.value) : parsed;
      if (result.ok) return ok(result.value);
      // One correction round for bad output, then fail closed. Provider failures never get here.
      if (attempt > 0) return err(result.error);
      messages.push(
        { role: "assistant", content: [{ type: "text", text: called.value || "(empty)" }] },
        { role: "user", content: CORRECTION },
      );
    }
  }
}
