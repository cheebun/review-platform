import { createServerFn } from "@tanstack/react-start";
import { authed } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import {
  loadMergeGates,
  loadMergeHistory,
  loadMergeQueue,
  parseMergeGatesInput,
  parseMergeHistoryInput,
  parseMergeInput,
  runMerge,
  type MergeDeps,
} from "./merge.logic";

/*
 * RPCs for /merge (FR-SHIP-05). `mergePrFn` is the only write: it pins the head SHA the user
 * confirmed, is rate limited per user, and never echoes GitHub's text (S4).
 */

const deps = async (): Promise<MergeDeps> => (await getContainer()).ports;

/** Reviewed, open, unmerged PRs in listed repos, with the GitHub configuration state. */
export const fetchMergeQueue = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async ({ context }) => loadMergeQueue(await deps(), context.actor));

/** One PR's live gate checklist (read-only; waits briefly for GitHub's mergeable signal). */
export const fetchMergeGates = createServerFn({ method: "GET" })
  .middleware([authed])
  .validator(parseMergeGatesInput)
  .handler(async ({ data, context }) => loadMergeGates(await deps(), context.actor, data));

/** Merges a PR at the confirmed head SHA, or returns the refusal code and gates. */
export const mergePrFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseMergeInput)
  .handler(async ({ data, context }) => runMerge(await deps(), context.actor, data));

/** Recorded merges, newest first. */
export const fetchMergeHistory = createServerFn({ method: "GET" })
  .middleware([authed])
  .validator(parseMergeHistoryInput)
  .handler(async ({ data, context }) => loadMergeHistory(await deps(), context.actor, data));
