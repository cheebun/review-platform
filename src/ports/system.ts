/** System ports. Nothing outside adapters may call `new Date()`, `randomUUID()` or `console`. */

export interface Clock {
  /** Returns a new `Date` on every call, so callers may mutate it freely. */
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that adds `fields` to every entry. */
  child(fields: LogFields): Logger;
}
