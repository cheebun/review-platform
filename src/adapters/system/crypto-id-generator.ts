import { randomUUID } from "node:crypto";
import type { IdGenerator } from "../../ports/system";

export class CryptoIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}
