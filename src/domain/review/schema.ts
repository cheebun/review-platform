import { z } from "zod";

/** Optional text: absent or null means "not provided"; any other non-string is an error. */
const optionalText = z.string().nullish();

const severitySchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.enum(["P0", "P1", "P2", "NIT"]))
  .transform((value) => (value === "NIT" ? ("Nit" as const) : value));

const nonBlank = z.string().trim().min(1);

export const findingSchema = z.object({
  severity: severitySchema,
  title: nonBlank,
  body: nonBlank,
  titleZh: optionalText,
  bodyZh: optionalText,
  path: optionalText,
  line: z.number().nullish(),
});

/** Shape the model must produce. Unknown keys are dropped. Anything else fails closed. */
export const aiReviewSchema = z.object({
  summary: nonBlank,
  summaryZh: optionalText,
  findings: z.array(findingSchema),
  verificationRequests: z.array(z.string()).nullish(),
  verificationRequestsZh: z.array(z.string()).nullish(),
});
