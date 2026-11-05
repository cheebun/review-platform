import { describe, expect, it } from "vitest";
import { selectStaleSchemas, STALE_AFTER_MS } from "./stale-schemas";

const now = new Date("2026-11-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe("selectStaleSchemas", () => {
  it("picks only test_* schemas older than 24h", () => {
    const rows = [
      { name: "test_old", comment: ago(STALE_AFTER_MS + 1) },
      { name: "test_fresh", comment: ago(STALE_AFTER_MS - 1000) },
      { name: "public", comment: ago(STALE_AFTER_MS * 10) },
      { name: "testimony", comment: ago(STALE_AFTER_MS * 10) },
      { name: "prod_old", comment: ago(STALE_AFTER_MS * 10) },
    ];
    expect(selectStaleSchemas(rows, now)).toEqual(["test_old"]);
  });

  it("also picks per-file schemas test_<runId>_<fileHash> left behind by a crashed run", () => {
    const rows = [
      { name: "test_mp2k1abc123_9f3a2c1d", comment: ago(STALE_AFTER_MS + 1) },
      { name: "test_mp2k1abc123_9f3a2c1d", comment: ago(1000) },
      { name: "test_a_b_c", comment: ago(STALE_AFTER_MS * 2) },
    ];
    expect(selectStaleSchemas(rows.slice(0, 1), now)).toEqual(["test_mp2k1abc123_9f3a2c1d"]);
    expect(selectStaleSchemas(rows.slice(1, 2), now)).toEqual([]);
    expect(selectStaleSchemas(rows.slice(2), now)).toEqual([]);
  });

  it("never selects a schema without a parsable timestamp comment", () => {
    const rows = [
      { name: "test_nocomment", comment: null },
      { name: "test_garbage", comment: "hello" },
    ];
    expect(selectStaleSchemas(rows, now)).toEqual([]);
  });

  it("does not select a schema exactly 24h old", () => {
    expect(selectStaleSchemas([{ name: "test_edge", comment: ago(STALE_AFTER_MS) }], now)).toEqual(
      [],
    );
  });

  it("rejects unsafe identifiers", () => {
    const rows = [{ name: 'test_x"; drop schema public;--', comment: ago(STALE_AFTER_MS * 2) }];
    expect(selectStaleSchemas(rows, now)).toEqual([]);
  });
});
