import type { AppStateRepo } from "../../ports/app-state-repo";
import type { Clock } from "../../ports/system";

export class InMemoryAppStateRepo implements AppStateRepo {
  private readonly rows = new Map<string, unknown>();

  constructor(private readonly clock: Clock) {
    void this.clock;
  }

  async get<T>(key: string) {
    return this.rows.has(key) ? (structuredClone(this.rows.get(key)) as T) : null;
  }

  async setIfAbsent<T>(key: string, value: T) {
    if (this.rows.has(key)) return false;
    this.rows.set(key, structuredClone(value));
    return true;
  }

  async set<T>(key: string, value: T) {
    this.rows.set(key, structuredClone(value));
  }
}
