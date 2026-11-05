import type {
  NewReviewEvent,
  ReviewEventRecord,
  ReviewEventFilter,
  ReviewEventRepo,
} from "../../ports/review-event-repo";

/** Append-only: there is deliberately no way to change or delete an event. */
export class InMemoryReviewEventRepo implements ReviewEventRepo {
  private readonly events: ReviewEventRecord[] = [];
  private nextFailure: Error | null = null;

  /** Test helper: the next insert throws `error`, as a failed INSERT would. */
  failNextAppend(error: Error = new Error("review_event insert failed")): void {
    this.nextFailure = error;
  }

  async append(event: NewReviewEvent): Promise<{ inserted: boolean }> {
    return this.appendNow(event);
  }

  /**
   * Synchronous insert, so the in-memory stores can write their row and its event without an
   * await in between (their stand-in for one transaction). Throws, and stores nothing, where the
   * PG table would reject the row (NOT NULL columns) or a failure was injected.
   */
  appendNow(event: NewReviewEvent): { inserted: boolean } {
    if (this.nextFailure) {
      const error = this.nextFailure;
      this.nextFailure = null;
      throw error;
    }
    if (
      !event.id ||
      !event.type ||
      !event.actor?.kind ||
      !event.actor.id ||
      !(event.at instanceof Date) ||
      Number.isNaN(event.at.getTime())
    ) {
      throw new Error("review_event violates a NOT NULL column");
    }
    if (
      event.jobId !== undefined &&
      this.events.some(
        (e) => e.jobId === event.jobId && e.prUrl === event.prUrl && e.type === event.type,
      )
    ) {
      return { inserted: false };
    }
    this.events.push(structuredClone(event));
    return { inserted: true };
  }

  async list(filter: ReviewEventFilter): Promise<ReviewEventRecord[]> {
    return this.events
      .filter(
        (e) =>
          (!filter.types || filter.types.includes(e.type)) &&
          (filter.prUrl === undefined || e.prUrl === filter.prUrl) &&
          (filter.reviewId === undefined || e.reviewId === filter.reviewId),
      )
      .toSorted((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id))
      .slice(0, filter.limit)
      .map((e) => structuredClone(e));
  }
}
