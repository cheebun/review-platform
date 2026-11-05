import { describe, expect, it } from "vitest";
import { FakeClock } from "./fake-clock";
import { MemoryLogger } from "./memory-logger";
import { SequenceIdGenerator } from "./sequence-id-generator";

describe("FakeClock", () => {
  it("set and advance, returning copies", () => {
    const c = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    c.advance(1500);
    expect(c.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    c.set(new Date("2030-01-01T00:00:00.000Z"));
    const n = c.now();
    n.setFullYear(1990);
    expect(c.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("SequenceIdGenerator", () => {
  it("is deterministic and uuid-shaped", () => {
    const a = new SequenceIdGenerator();
    const b = new SequenceIdGenerator();
    const ids = [a.uuid(), a.uuid()];
    expect(ids).toEqual([b.uuid(), b.uuid()]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("MemoryLogger", () => {
  it("records entries and child fields share the sink", () => {
    const log = new MemoryLogger();
    log.child({ requestId: "r" }).info("hi", { a: 1 });
    log.error("bad");
    expect(log.entries).toEqual([
      { level: "info", msg: "hi", fields: { requestId: "r", a: 1 } },
      { level: "error", msg: "bad", fields: {} },
    ]);
  });
});
