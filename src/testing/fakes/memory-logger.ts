import type { LogFields, Logger } from "../../ports/system";

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields: LogFields;
}

export class MemoryLogger implements Logger {
  constructor(
    readonly entries: LogEntry[] = [],
    private readonly bindings: LogFields = {},
  ) {}

  debug(msg: string, fields?: LogFields) {
    this.push("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields) {
    this.push("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields) {
    this.push("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields) {
    this.push("error", msg, fields);
  }

  child(fields: LogFields): Logger {
    return new MemoryLogger(this.entries, { ...this.bindings, ...fields });
  }

  private push(level: LogEntry["level"], msg: string, fields?: LogFields) {
    this.entries.push({ level, msg, fields: { ...this.bindings, ...fields } });
  }
}
