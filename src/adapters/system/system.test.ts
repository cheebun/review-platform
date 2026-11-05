import { describe, expect, it } from "vitest";
import { ConsoleLogger } from "./console-logger";
import { CryptoIdGenerator } from "./crypto-id-generator";
import { SystemClock } from "./system-clock";
import { FakeClock } from "../../testing/fakes/fake-clock";

function capture() {
  const lines: string[] = [];
  return { lines, write: (l: string) => lines.push(l) };
}

describe("ConsoleLogger", () => {
  it("writes one JSON line with level, msg, time and fields", () => {
    const c = capture();
    const clock = new FakeClock(new Date("2026-01-02T03:04:05.000Z"));
    new ConsoleLogger({ write: c.write, clock }).info("hello", { jobId: "j1" });
    expect(c.lines).toHaveLength(1);
    expect(JSON.parse(c.lines[0]!)).toEqual({
      level: "info",
      msg: "hello",
      time: "2026-01-02T03:04:05.000Z",
      jobId: "j1",
    });
  });

  it("redacts sensitive keys, case-insensitively and in nested objects", () => {
    const c = capture();
    new ConsoleLogger({ write: c.write }).warn("x", {
      apiToken: "t0k",
      CLIENT_SECRET: "s3c",
      password: "pw",
      accessKey: "k",
      Authorization: "Bearer abc",
      cookie: "c",
      databaseUrl: "postgresql://u:p@h/db",
      nested: { slackToken: "n", safe: 1 },
      list: [{ token: "arr" }],
      repo: "o/r",
    });
    const raw = c.lines[0]!;
    for (const leak of ["t0k", "s3c", "pw", "Bearer abc", "u:p@h", "arr"]) {
      expect(raw).not.toContain(leak);
    }
    const out = JSON.parse(raw);
    expect(out.apiToken).toBe("[REDACTED]");
    expect(out.nested).toEqual({ slackToken: "[REDACTED]", safe: 1 });
    expect(out.repo).toBe("o/r");
  });

  it("child() merges bound fields and call fields win", () => {
    const c = capture();
    const log = new ConsoleLogger({ write: c.write }).child({ requestId: "r1", a: 1 });
    log.child({ b: 2 }).error("boom", { a: 9 });
    expect(JSON.parse(c.lines[0]!)).toMatchObject({ level: "error", requestId: "r1", a: 9, b: 2 });
  });

  it("does not let fields overwrite level/msg/time", () => {
    const c = capture();
    new ConsoleLogger({ write: c.write }).debug("real", { level: "fake", msg: "fake" });
    expect(JSON.parse(c.lines[0]!)).toMatchObject({ level: "debug", msg: "real" });
  });

  it("survives circular fields", () => {
    const c = capture();
    const a: Record<string, unknown> = {};
    a.self = a;
    new ConsoleLogger({ write: c.write }).info("c", { a });
    expect(JSON.parse(c.lines[0]!).msg).toBe("c");
  });
});

describe("SystemClock", () => {
  it("returns a fresh Date close to real time each call", () => {
    const clock = new SystemClock();
    const a = clock.now();
    const b = clock.now();
    expect(a).not.toBe(b);
    expect(Math.abs(a.getTime() - Date.now())).toBeLessThan(1000);
    a.setFullYear(1999);
    expect(clock.now().getFullYear()).not.toBe(1999);
  });
});

describe("CryptoIdGenerator", () => {
  it("returns unique v4 uuids", () => {
    const g = new CryptoIdGenerator();
    const a = g.uuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(g.uuid()).not.toBe(a);
  });
});
