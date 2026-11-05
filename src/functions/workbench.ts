import { createServerFn } from "@tanstack/react-start";
import { authed } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import {
  loadMergeSummary,
  loadReviewSummary,
  loadSetupStatus,
  type WorkbenchDeps,
} from "./workbench.logic";

/*
 * UI-only, read-only RPCs for the overview `/`. One per card, so one failing card never breaks
 * another. None calls an upstream service.
 */

const deps = async (): Promise<WorkbenchDeps> => (await getContainer()).ports;

/** Review counts by outcome over the last 7 UTC+8 days, and the latest reviews. */
export const fetchReviewSummary = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async () => loadReviewSummary(await deps()));

/** How many reviewed PRs await merge, from stored records (no GitHub call). */
export const fetchMergeSummary = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async () => loadMergeSummary(await deps()));

/** Which /settings sections are configured. States only, never a value. */
export const fetchSetupStatus = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async () => loadSetupStatus(await deps()));
