/**
 * Maps the domain's terminal review records (3c) to the `review_result` rows (3d) and the
 * `review_event` rows of the same run (FR-REVIEW-05, FR-REVIEW-06). Pure.
 */
import { parsePrUrl } from "../../domain/github/pr-ref";
import type { ReviewRecord as DomainRecord } from "../../domain/review/types";
import type { UrlProgress } from "../../domain/review-queue/types";
import { err, ok, type Result } from "../../domain/shared/result";
import type { EventActor, NewReviewEvent } from "../../ports/review-event-repo";
import type { NewReviewRecord } from "../../ports/review-record-repo";

/** The review pipeline acting on the owner's behalf (FR-SHIP-01 AC 1e). */
export const SYSTEM_ACTOR: EventActor = { kind: "system", id: "review-pipeline" };
export const AUTO_APPROVE_REASON = "auto: review passed";

export type ReviewerLabel = { provider?: string; model?: string };

export function toNewReviewRecord(
  rec: DomainRecord,
  id: string,
  label: ReviewerLabel = {},
): Result<NewReviewRecord> {
  const ref = rec.pr ? null : parsePrUrl(rec.prUrl);
  if (ref && !ref.ok) return err(ref.error);
  const owner = rec.pr?.owner ?? ref!.value!.owner;
  const repo = rec.pr?.repo ?? ref!.value!.repo;
  const number = rec.pr?.number ?? ref!.value!.number;
  const completed = rec.status === "done" && rec.verdict !== null;
  const out: NewReviewRecord = {
    id,
    jobId: rec.jobId,
    run: rec.attempt,
    prUrl: rec.prUrl,
    owner,
    repo,
    number,
    source: rec.source,
    // A job always has a requester today; an unknown one is recorded, never invented as a user.
    requester: rec.requester ?? { kind: "machine", id: "unknown" },
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    status: completed ? "completed" : "failed",
    findings: rec.findings,
  };
  if (rec.pr) {
    out.headSha = rec.pr.headSha;
    out.baseSha = rec.pr.baseSha;
  }
  if (label.provider) out.provider = label.provider;
  if (label.model) out.model = label.model;
  if (completed) out.verdict = rec.verdict!;
  else out.errorCategory = rec.failure ?? "internal";
  if (rec.summary !== null) out.summary = rec.summary;
  return ok(out);
}

/**
 * The events of one URL's run, keyed (job, url, type) so a replayed transaction adds nothing.
 * Order: comment, verdict, approve outcome, then the review's own end.
 */
export function reviewEventsFor(input: {
  record: DomainRecord;
  recordId: string;
  progress: UrlProgress;
  newId: () => string;
}): NewReviewEvent[] {
  const { record, recordId, progress } = input;
  const base = {
    actor: SYSTEM_ACTOR,
    at: record.finishedAt,
    prUrl: record.prUrl,
    reviewId: recordId,
    jobId: record.jobId,
    source: record.source,
    ...(record.pr ? { sha: record.pr.headSha } : {}),
  } as const;
  const events: NewReviewEvent[] = [];
  const push = (e: Omit<NewReviewEvent, keyof typeof base | "id"> & Partial<NewReviewEvent>) =>
    events.push({ ...base, ...e, id: input.newId() } as NewReviewEvent);

  if (progress.commented) {
    push({
      type: "comment_posted",
      ...(progress.githubReviewId ? { detail: { githubReviewId: progress.githubReviewId } } : {}),
    });
  }
  if (record.status === "done" && record.verdict === "changes_requested") {
    push({ type: "changes_requested" });
  }
  const a = record.approve;
  if (a?.step === "approved") {
    push({
      type: "approved",
      sha: a.sha,
      reason: AUTO_APPROVE_REASON,
      detail: { githubReviewId: a.githubReviewId },
    });
  } else if (a?.step === "approve_skipped" || a?.step === "approve_failed") {
    push({ type: a.step, sha: a.sha, reason: a.reason });
  }
  if (record.status === "done" && record.verdict !== null) {
    push({ type: "review_finished", detail: { verdict: record.verdict } });
  } else {
    push({ type: "review_failed", reason: record.failure ?? "internal" });
  }
  return events;
}
