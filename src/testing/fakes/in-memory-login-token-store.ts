import { err, ok } from "../../domain/shared/result";
import {
  ALREADY_INITIALIZED,
  assertLoginTokenHash,
  LOGIN_TOKEN_NOT_FOUND,
  type LoginTokenStore,
} from "../../ports/login-token-store";
import type { Clock } from "../../ports/system";

export class InMemoryLoginTokenStore implements LoginTokenStore {
  private row: { tokenHash: string; createdAt: Date; rotatedAt: Date | null } | null = null;

  constructor(private readonly clock: Clock) {}

  async isInitialized() {
    return this.row !== null;
  }

  async getHash() {
    return this.row?.tokenHash ?? null;
  }

  async initialize(hash: string) {
    assertLoginTokenHash(hash);
    // Check and set in one synchronous step: concurrent callers cannot interleave.
    if (this.row) return err(ALREADY_INITIALIZED);
    this.row = { tokenHash: hash, createdAt: this.clock.now(), rotatedAt: null };
    return ok(undefined);
  }

  async rotate(hash: string) {
    assertLoginTokenHash(hash);
    if (!this.row) return err(LOGIN_TOKEN_NOT_FOUND);
    this.row = { ...this.row, tokenHash: hash, rotatedAt: this.clock.now() };
    return ok(undefined);
  }

}
