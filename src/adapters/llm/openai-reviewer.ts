import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import { toAiReviewResult } from "../../domain/review/review";
import type { AiReviewResult } from "../../domain/review/types";
import type { ReviewInput, Reviewer } from "../../ports/reviewer";
import type OpenAI from "openai";
import { parseJsonText } from "./json";
import { OpenAiTool } from "./openai-structured";
import type { LlmCallOptions, OpenAiAdapterOptions } from "./options";
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "./review-prompt";
import { REVIEW_JSON_SCHEMA, SUBMIT_REVIEW_DESCRIPTION, SUBMIT_REVIEW_NAME } from "./review-schema";

const TOOL: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: SUBMIT_REVIEW_NAME,
  description: SUBMIT_REVIEW_DESCRIPTION,
  parameters: REVIEW_JSON_SCHEMA,
  // Strict mode would require every optional field (path / line) to be listed as required.
  strict: false,
};

export class OpenAiReviewer implements Reviewer {
  private readonly llm: OpenAiTool;

  constructor(options: OpenAiAdapterOptions) {
    this.llm = new OpenAiTool(options, { reasoningEffort: "medium" });
  }

  async review(
    input: ReviewInput,
    options: LlmCallOptions = {},
  ): Promise<Result<AiReviewResult, DomainError>> {
    const called = await this.llm.call(
      {
        instructions: REVIEW_SYSTEM_PROMPT,
        input: buildReviewPrompt(input, "tool"),
        tool: TOOL,
      },
      options,
    );
    if (!called.ok) return err(called.error);
    const parsed = parseJsonText(called.value);
    if (!parsed.ok) return err(parsed.error);
    const result = toAiReviewResult(parsed.value);
    return result.ok ? ok(result.value) : err(result.error);
  }
}
