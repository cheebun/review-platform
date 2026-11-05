import { createClient } from "redis";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

const client = createClient({
  url: process.env.TEST_REDIS_URL,
  socket: { connectTimeout: 20_000, reconnectStrategy: false },
});
// An error handler is required, and must not leak the connection string.
client.on("error", () => {});
beforeAll(() => client.connect());
afterAll(() => client.quit());

it("SET, GET and UNLINK a key under the run prefix over TLS (rediss)", async () => {
  expect(new URL(process.env.TEST_REDIS_URL!).protocol).toBe("rediss:");
  const key = `${inject("redisPrefix")}smoke`;
  expect(key).toMatch(/^test:[a-z0-9]+:smoke$/);
  expect(await client.set(key, "hello")).toBe("OK");
  expect(await client.get(key)).toBe("hello");
  expect(await client.unlink(key)).toBe(1);
  expect(await client.get(key)).toBeNull();
});
