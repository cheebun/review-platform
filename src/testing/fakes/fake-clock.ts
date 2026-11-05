import type { Clock } from "../../ports/system";

export class FakeClock implements Clock {
  private ms: number;

  constructor(start: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.ms = start.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  set(date: Date): void {
    this.ms = date.getTime();
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
