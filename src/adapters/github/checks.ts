import { z } from "zod";
import type { ChecksState, ChecksSummary } from "../../ports/github";

export const checkRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
});
export type CheckRun = z.infer<typeof checkRunSchema>;

export const commitStatusSchema = z.object({
  id: z.number(),
  context: z.string(),
  state: z.string(),
});
export type CommitStatus = z.infer<typeof commitStatusSchema>;

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const RANK: Record<ChecksState, number> = { green: 0, pending: 1, failing: 2 };

function runState(run: CheckRun): ChecksState {
  if (run.status !== "completed") return "pending";
  // Unknown or missing conclusions fail closed.
  return PASSING_CONCLUSIONS.has(run.conclusion ?? "") ? "green" : "failing";
}

function statusState(status: CommitStatus): ChecksState {
  if (status.state === "success") return "green";
  if (status.state === "pending") return "pending";
  return "failing";
}

/**
 * Combines check runs and commit statuses. Statuses are reduced to the newest (highest id) per
 * context; a name reported several times takes its worst state.
 */
export function summarizeChecks(runs: CheckRun[], statuses: CommitStatus[]): ChecksSummary {
  const byName = new Map<string, { name: string; state: ChecksState }>();
  const note = (key: string, name: string, state: ChecksState) => {
    const previous = byName.get(key);
    if (!previous || RANK[state] > RANK[previous.state]) byName.set(key, { name, state });
  };
  for (const run of runs) note(`run:${run.name}`, run.name, runState(run));

  const newest = new Map<string, CommitStatus>();
  for (const status of statuses) {
    const seen = newest.get(status.context);
    if (!seen || status.id > seen.id) newest.set(status.context, status);
  }
  for (const status of newest.values()) {
    note(`status:${status.context}`, status.context, statusState(status));
  }

  const entries = [...byName.values()];
  const namesIn = (state: ChecksState) =>
    [...new Set(entries.filter((e) => e.state === state).map((e) => e.name))].toSorted();
  const failing = namesIn("failing");
  const pending = namesIn("pending");
  const state: ChecksState =
    failing.length > 0 ? "failing" : pending.length > 0 ? "pending" : "green";
  return { state, failing, pending, total: entries.length };
}
