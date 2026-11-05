export const SUBMIT_REVIEW_NAME = "submit_pr_review";
export const SUBMIT_REVIEW_DESCRIPTION =
  "Submit the structured PR review result. English fields go to GitHub; Chinese fields are for the local UI.";

/**
 * JSON Schema for the review. Hand-written (copied from the legacy tool schema) rather than
 * derived from the zod schema, because that schema normalises with transforms that have no JSON
 * Schema form. The domain zod schema stays the validator of record: the model output is always
 * re-validated by `toAiReviewResult`.
 */
export const REVIEW_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: {
      type: "string",
      description: "1-3 sentences in English: what changed and main risk areas.",
    },
    summaryZh: {
      type: "string",
      description: "Simplified Chinese version of summary.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["P0", "P1", "P2", "Nit"],
          },
          title: { type: "string", description: "Short English title" },
          titleZh: { type: "string", description: "Chinese short title" },
          body: {
            type: "string",
            description: "English what/why/fix. Single string; use \\n if needed.",
          },
          bodyZh: {
            type: "string",
            description: "Simplified Chinese body with what/why/fix.",
          },
          path: { type: "string", description: "Optional file path" },
          line: { type: "number", description: "Optional line number" },
        },
        required: ["severity", "title", "titleZh", "body", "bodyZh"],
        additionalProperties: false,
      },
    },
    verificationRequests: {
      type: "array",
      items: { type: "string" },
      description: "English verification items (1-3+).",
    },
    verificationRequestsZh: {
      type: "array",
      items: { type: "string" },
      description: "Simplified Chinese verification items.",
    },
  },
  required: ["summary", "summaryZh", "findings", "verificationRequests", "verificationRequestsZh"],
  additionalProperties: false,
};
