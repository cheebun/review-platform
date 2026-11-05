import type { IdGenerator } from "../../ports/system";

/** Deterministic uuid-shaped ids: 00000000-0000-4000-8000-000000000001, ...002, ... */
export class SequenceIdGenerator implements IdGenerator {
  private n = 0;

  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}
