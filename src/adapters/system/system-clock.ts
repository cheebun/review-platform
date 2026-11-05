import type { Clock } from "../../ports/system";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
