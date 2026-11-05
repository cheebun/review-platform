import { ok, type DomainError, type Result } from "../../domain/shared/result";
import type { AiReviewResult } from "../../domain/review/types";
import type { ReviewInput, Reviewer } from "../../ports/reviewer";

export const approvingReview = (): AiReviewResult => ({
  summary: "Fake review: no issues.",
  findings: [],
  verificationRequests: ["Verify the changed critical user paths still work as expected."],
});

/** Scripted `Reviewer`. Answers are consumed in order, and the last one repeats. */
export class FakeReviewer implements Reviewer {
  readonly calls: ReviewInput[] = [];
  private readonly answers: Result<AiReviewResult, DomainError>[];

  constructor(...answers: Result<AiReviewResult, DomainError>[]) {
    this.answers = answers.length > 0 ? answers : [ok(approvingReview())];
  }

  async review(input: ReviewInput): Promise<Result<AiReviewResult, DomainError>> {
    this.calls.push(input);
    return this.answers[Math.min(this.calls.length, this.answers.length) - 1]!;
  }
}
