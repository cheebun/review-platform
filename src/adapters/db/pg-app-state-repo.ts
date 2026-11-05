import { eq } from "drizzle-orm";
import type { AppStateRepo } from "../../ports/app-state-repo";
import type { Clock } from "../../ports/system";
import type { Db } from "./client";
import { appState } from "./schema";

export class PgAppStateRepo implements AppStateRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const [row] = await this.db
      .select({ value: appState.value })
      .from(appState)
      .where(eq(appState.key, key));
    return row ? (row.value as T) : null;
  }

  async setIfAbsent<T>(key: string, value: T): Promise<boolean> {
    const rows = await this.db
      .insert(appState)
      .values({ key, value, updatedAt: this.clock.now() })
      .onConflictDoNothing()
      .returning({ key: appState.key });
    return rows.length > 0;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const now = this.clock.now();
    await this.db
      .insert(appState)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: now } });
  }
}
