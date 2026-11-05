import { createServerFn } from "@tanstack/react-start";
import { authed } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import {
  loadReviewDetail,
  loadReviewList,
  parseReviewIdInput,
  parseReviewListInput,
  type ReviewDeps,
} from "./review.logic";

/*
 * UI-only, read-only RPCs for /review and /review/$reviewId (FR-REVIEW-06, FR-REVIEW-07).
 * There is deliberately no write function here: both pages are view-only (Q26, decided).
 */

const deps = async (): Promise<ReviewDeps> => (await getContainer()).ports;

/** One page of review history, newest first, with the repo list for the filter. */
export const fetchReviewList = createServerFn({ method: "GET" })
  .middleware([authed])
  .validator(parseReviewListInput)
  .handler(async ({ data, context }) => loadReviewList(await deps(), context.actor, data));

/** One review record with its findings and the PR's event timeline; `not_found` for unknown ids. */
export const fetchReviewDetail = createServerFn({ method: "GET" })
  .middleware([authed])
  .validator(parseReviewIdInput)
  .handler(async ({ data, context }) => loadReviewDetail(await deps(), context.actor, data));
