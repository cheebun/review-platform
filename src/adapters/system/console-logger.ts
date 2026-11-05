import type { Clock, LogFields, Logger } from "../../ports/system";
import { SystemClock } from "./system-clock";

type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY = /token|secret|password|key|authorization|cookie|url/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, seen, depth + 1);
  }
  return out;
}

export interface ConsoleLoggerOptions {
  /** One JSON line per call. Defaults to stdout (stderr for warn and error). */
  write?: (line: string, level: Level) => void;
  clock?: Clock;
  bindings?: LogFields;
}

function defaultWrite(line: string, level: Level): void {
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

export class ConsoleLogger implements Logger {
  private readonly write: (line: string, level: Level) => void;
  private readonly clock: Clock;
  private readonly bindings: LogFields;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.write = options.write ?? defaultWrite;
    this.clock = options.clock ?? new SystemClock();
    this.bindings = options.bindings ?? {};
  }

  debug(msg: string, fields?: LogFields) {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields) {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields) {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields) {
    this.log("error", msg, fields);
  }

  child(fields: LogFields): Logger {
    return new ConsoleLogger({
      write: this.write,
      clock: this.clock,
      bindings: { ...this.bindings, ...fields },
    });
  }

  private log(level: Level, msg: string, fields?: LogFields) {
    const safe = redact({ ...this.bindings, ...fields }, new WeakSet(), 0) as Record<
      string,
      unknown
    >;
    const entry = { ...safe, level, msg, time: this.clock.now().toISOString() };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ level, msg, time: entry.time, logError: "unserializable fields" });
    }
    this.write(line, level);
  }
}
