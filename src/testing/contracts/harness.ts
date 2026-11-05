import type {
  EventDetail,
  NewReviewEvent,
  ReviewEventRepo,
  SettingsEventType,
} from "../../ports/review-event-repo";

export type ContractHarness<T> = {
  impl: T;
  /** Moves time forward. A fake advances its clock; a real adapter sleeps. */
  advance(ms: number): Promise<void>;
  cleanup(): Promise<void>;
};

export type MakeHarness<T> = () => Promise<ContractHarness<T>>;

/** Polls until `check` passes. Used where delivery is asynchronous (WakeUp). */
export async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A harness for a store that records history events; `events` reads the same database. */
export type EventfulHarness<T> = ContractHarness<T> & { events: ReviewEventRepo };
export type MakeEventfulHarness<T> = () => Promise<EventfulHarness<T>>;

let eventSeq = 0;
/** A valid settings event; ids are unique across the run (`review_event.id` is the key). */
export const aSettingsEvent = (
  type: SettingsEventType,
  detail: EventDetail = {},
): NewReviewEvent => ({
  id: `ev-contract-${process.pid}-${++eventSeq}`,
  type,
  actor: { kind: "user", id: "owner-1" },
  at: new Date("2026-11-04T02:00:00.000Z"),
  source: "web",
  detail,
});

/** An event every implementation must refuse to store (`actor_id` is NOT NULL). */
export const aRejectedEvent = (type: SettingsEventType): NewReviewEvent => ({
  ...aSettingsEvent(type),
  actor: { kind: "user", id: null as unknown as string },
});
