import { describe, expect, it } from "vitest";
import { assertNotProduction } from "./guard";

describe("assertNotProduction", () => {
  it("rejects when the test database URL equals DATABASE_URL", () => {
    expect(() =>
      assertNotProduction({ TEST_DATABASE_URL: "pg://same", DATABASE_URL: "pg://same" }),
    ).toThrow(/TEST_DATABASE_URL.*DATABASE_URL/);
  });

  it("rejects when the test Redis URL equals REDIS_URL", () => {
    expect(() =>
      assertNotProduction({
        TEST_DATABASE_URL: "pg://a",
        TEST_REDIS_URL: "redis://same",
        REDIS_URL: "redis://same",
      }),
    ).toThrow(/TEST_REDIS_URL.*REDIS_URL/);
  });

  it("never echoes the URL in the error message", () => {
    try {
      assertNotProduction({
        TEST_DATABASE_URL: "pg://secret-host",
        DATABASE_URL: "pg://secret-host",
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("secret-host");
    }
  });

  it("passes when the URLs differ or the production ones are unset", () => {
    expect(() =>
      assertNotProduction({ TEST_DATABASE_URL: "pg://a", DATABASE_URL: "pg://b" }),
    ).not.toThrow();
    expect(() =>
      assertNotProduction({ TEST_DATABASE_URL: "pg://a", TEST_REDIS_URL: "redis://a" }),
    ).not.toThrow();
  });

  it("requires the test URLs to be present", () => {
    expect(() => assertNotProduction({})).toThrow(/TEST_DATABASE_URL/);
  });
});
