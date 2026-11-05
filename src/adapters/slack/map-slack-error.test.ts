import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { mapSlackError } from "./map-slack-error";

const platform = (error: string) => new WebAPIPlatformError({ ok: false, error });
const http = (status: number, headers: Record<string, string> = {}) =>
  new WebAPIHTTPError(status, "x", headers, undefined);

describe("mapSlackError (by error.code and error.data.error, never by message)", () => {
  it.each(["not_authed", "invalid_auth", "token_revoked", "account_inactive", "missing_scope"])(
    "platform %s -> forbidden",
    (code) => {
      expect(mapSlackError(platform(code)).kind).toBe("forbidden");
    },
  );

  it.each(["channel_not_found", "user_not_found", "message_not_found"])(
    "platform %s -> not_found",
    (code) => {
      expect(mapSlackError(platform(code)).kind).toBe("not_found");
    },
  );

  it("platform ratelimited -> rate_limited", () => {
    expect(mapSlackError(platform("ratelimited")).kind).toBe("rate_limited");
  });

  it.each(["internal_error", "service_unavailable", "fatal_error", "request_timeout"])(
    "platform %s -> retryable upstream",
    (code) => {
      expect(mapSlackError(platform(code))).toEqual({
        kind: "upstream",
        service: "slack",
        retryable: true,
      });
    },
  );

  it("an unknown platform code -> non-retryable upstream", () => {
    expect(mapSlackError(platform("invalid_blocks"))).toEqual({
      kind: "upstream",
      service: "slack",
      retryable: false,
    });
  });

  it("WebAPIRateLimitedError carries retryAfter seconds as milliseconds", () => {
    expect(mapSlackError(new WebAPIRateLimitedError(12))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 12000,
    });
  });

  it("HTTP 429 uses the Retry-After header; 5xx is retryable; other 4xx is not", () => {
    expect(mapSlackError(http(429, { "retry-after": "3" }))).toEqual({
      kind: "rate_limited",
      retryAfterMs: 3000,
    });
    expect(mapSlackError(http(503))).toEqual({
      kind: "upstream",
      service: "slack",
      retryable: true,
    });
    expect(mapSlackError(http(400))).toEqual({
      kind: "upstream",
      service: "slack",
      retryable: false,
    });
    expect(mapSlackError(http(401)).kind).toBe("forbidden");
  });

  it("network errors -> retryable upstream", () => {
    expect(mapSlackError(new WebAPIRequestError(new Error("ECONNRESET")))).toEqual({
      kind: "upstream",
      service: "slack",
      retryable: true,
    });
  });

  it("never matches on message strings", () => {
    const e = new Error("invalid_auth channel_not_found ratelimited");
    expect(mapSlackError(e)).toEqual({ kind: "upstream", service: "slack", retryable: false });
    const spoof = Object.assign(new Error("not_authed"), { code: "something_else" });
    expect(mapSlackError(spoof).kind).toBe("upstream");
  });

  it("does not leak SDK messages into the error", () => {
    const e = new WebAPIPlatformError({
      ok: false,
      error: "invalid_auth",
      secret: "xoxp-leak",
    } as never);
    expect(JSON.stringify(mapSlackError(e))).not.toContain("xoxp-leak");
  });
});
