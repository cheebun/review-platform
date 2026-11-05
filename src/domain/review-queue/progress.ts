import { z } from "zod";
import type { DomainError, Result } from "../shared/result";
import type { UrlProgress } from "./types";

// Every object is strict. Progress is loaded from `jsonb`, and the only writer is this codebase, so an
// unknown key means schema drift or corruption. Stripping it would silently drop checkpoint data and
// could replay a GitHub write; rejecting it fails closed and leaves the job for an operator.

const id = z.number().int().positive();

const FindingSchema = z.strictObject({
  severity: z.enum(["P0", "P1", "P2", "Nit"]),
  title: z.string(),
  body: z.string(),
  titleZh: z.string().optional(),
  bodyZh: z.string().optional(),
  path: z.string().optional(),
  line: z.number().int().optional(),
});

const ReviewResultSchema = z.strictObject({
  summary: z.string(),
  summaryZh: z.string().optional(),
  findings: z.array(FindingSchema),
  verificationRequests: z.array(z.string()),
  verificationRequestsZh: z.array(z.string()).optional(),
});

const PrSchema = z.strictObject({
  owner: z.string(),
  repo: z.string(),
  number: id,
  title: z.string(),
  author: z.string(),
  htmlUrl: z.string(),
  base: z.string(),
  head: z.string(),
  sha: z.string(),
  baseSha: z.string(),
});

const BatchReviewSchema = z.strictObject({
  fingerprint: z.string(),
  total: z.number().int().nonnegative(),
  results: z.array(ReviewResultSchema),
});

const sha = z.string().min(1);
const reason = z.string().trim().min(1).max(500);

const outcomes = [
  z.strictObject({ step: z.literal("approved"), sha, githubReviewId: id }),
  z.strictObject({ step: z.literal("approve_skipped"), sha, reason }),
  z.strictObject({ step: z.literal("approve_failed"), sha, reason }),
] as const;

/** The resolved auto-approve checkpoint (anything but `approve_pending`). */
export const ApproveOutcomeSchema = z.discriminatedUnion("step", [...outcomes]);

const ApproveSchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("approve_pending"), sha }),
  ...outcomes,
]);

export const UrlProgressSchema = z.strictObject({
  reviewed: z.boolean().optional(),
  commented: z.boolean().optional(),
  submitted: z.boolean().optional(),
  merged: z.boolean().optional(),
  replied: z.boolean().optional(),
  reacted: z.boolean().optional(),
  completed: z.boolean().optional(),
  pr: PrSchema.optional(),
  review: ReviewResultSchema.optional(),
  batchReview: BatchReviewSchema.optional(),
  commentId: id.optional(),
  githubReviewId: id.optional(),
  result: z.unknown().optional(),
  reviewSeq: z.number().int().nonnegative().optional(),
  approve: ApproveSchema.optional(),
  recorded: z.boolean().optional(),
});

// Compile-time check that the schema and the `UrlProgress` type agree.
type _Same = z.infer<typeof UrlProgressSchema> extends UrlProgress ? true : never;
export const progressSchemaMatchesType: _Same = true;

const ProgressRecordSchema = z.record(z.string(), UrlProgressSchema);

export function toValidationError(error: z.ZodError): DomainError {
  const issue = error.issues[0];
  return {
    kind: "validation",
    field: issue?.path.map(String).join(".") || undefined,
    // Zod messages describe the shape, never echo the payload.
    message: issue?.message ?? "invalid payload",
  };
}

/** Validates an untrusted `progress` payload. Never throws. */
export function parseReviewJobProgress(
  raw: unknown,
): Result<Record<string, UrlProgress>, DomainError> {
  const parsed = ProgressRecordSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data as Record<string, UrlProgress> }
    : { ok: false, error: toValidationError(parsed.error) };
}
