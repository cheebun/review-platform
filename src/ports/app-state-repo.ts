/** Small durable key/value state, e.g. `capture_since`. Values are JSON-serialisable. */
export interface AppStateRepo {
  get<T>(key: string): Promise<T | null>;
  /** Stores `value` only when `key` has no value yet. Returns true only for the writer that stored it. */
  setIfAbsent<T>(key: string, value: T): Promise<boolean>;
  set<T>(key: string, value: T): Promise<void>;
}
