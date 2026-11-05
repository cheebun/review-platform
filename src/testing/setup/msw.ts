import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "../http/server";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

beforeAll(() =>
  server.listen({
    // msw 3 calls this `onUnhandledFrame` (`onUnhandledRequest` is silently ignored).
    // Unhandled external requests fail the test, so nothing can reach the real internet.
    // Loopback is allowed so tests may run their own throwaway local http servers.
    async onUnhandledFrame({ frame, defaults }) {
      const data = frame.data as { request?: Request };
      if (data.request && loopback.has(new URL(data.request.url).hostname)) return;
      await defaults.error();
      // msw only turns a thrown `Response` into a client-side failure; any other thrown value
      // becomes a silently swallowable HTTP 500. `Response.error()` makes fetch itself reject.
      throw Response.error();
    },
  }),
);
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
