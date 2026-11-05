import { describe, expect, it } from "vitest";
import { NOT_MIGRATED_MESSAGE, notMigratedMessage } from "./db-errors";

const pgError = (code: string) =>
  Object.assign(new Error('relation "app_state" does not exist'), { code });

describe("notMigratedMessage", () => {
  it("maps undefined_table (42P01) to the migrate hint", () => {
    expect(notMigratedMessage(pgError("42P01"))).toBe(NOT_MIGRATED_MESSAGE);
  });

  it("finds the code on a drizzle-style wrapper's cause", () => {
    const wrapped = new Error('Failed query: select "value" from "app_state"', {
      cause: pgError("42P01"),
    });
    expect(notMigratedMessage(wrapped)).toBe(NOT_MIGRATED_MESSAGE);
  });

  it("maps undefined_schema-free errors to nothing", () => {
    expect(notMigratedMessage(pgError("28P01"))).toBeUndefined();
    expect(notMigratedMessage(new Error("boom"))).toBeUndefined();
    expect(notMigratedMessage("42P01")).toBeUndefined();
    expect(notMigratedMessage(undefined)).toBeUndefined();
  });

  it("does not loop on a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    a.cause = a;
    expect(notMigratedMessage(a)).toBeUndefined();
  });
});
