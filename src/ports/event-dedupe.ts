export interface EventDedupe {
  /** True only for the first claimer of `eventId`, until `ttlMs` expires. */
  claim(eventId: string, ttlMs: number): Promise<boolean>;
}
