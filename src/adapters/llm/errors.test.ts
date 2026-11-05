import * as Anthropic from "@anthropic-ai/sdk";
import * as OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import { mapLlmError } from "./errors";

const headers = new Headers();
const upstream = (retryable: boolean) => ({ kind: "upstream", service: "llm", retryable });

describe.each([
  ["Anthropic", Anthropic],
  ["OpenAI", OpenAI],
] as const)("mapLlmError (%s typed errors)", (_name, sdk) => {
  const map = (error: unknown) => mapLlmError(error, undefined, sdk);
  const generate = (status: number) =>
    (sdk.APIError as typeof Anthropic.APIError).generate(
      status,
      { error: { message: "boom" } },
      "boom",
      headers,
    );

  it.each([429, 500, 502, 503, 529, 408, 409])("%i is retryable", (status) => {
    expect(map(generate(status))).toEqual(upstream(true));
  });

  it.each([400, 401, 403, 404, 422])("%i is not retryable", (status) => {
    expect(map(generate(status))).toEqual(upstream(false));
  });

  it("maps typed classes, not messages", () => {
    // The message says "rate limit" but the class is BadRequestError.
    const bad = (sdk.APIError as typeof Anthropic.APIError).generate(
      400,
      { error: { message: "rate limit exceeded 429" } },
      "rate limit exceeded 429",
      headers,
    );
    expect(bad).toBeInstanceOf(sdk.BadRequestError);
    expect(map(bad)).toEqual(upstream(false));
  });

  it("connection errors and timeouts are retryable", () => {
    expect(map(new sdk.APIConnectionError({ message: "down" }))).toEqual(upstream(true));
    expect(map(new sdk.APIConnectionTimeoutError({ message: "slow" }))).toEqual(upstream(true));
  });

  it("an aborted request is not retryable", () => {
    expect(map(new sdk.APIUserAbortError())).toEqual(upstream(false));
  });
});

describe("mapLlmError (other)", () => {
  it("an API error without a status (in-stream error event) is retryable", () => {
    expect(mapLlmError(new Anthropic.APIError(undefined, { type: "error" }, "x", headers))).toEqual(
      upstream(true),
    );
  });

  it("an unknown thrown value is upstream and not retryable", () => {
    for (const value of [new Error("x"), "boom", null, undefined, 42]) {
      expect(mapLlmError(value)).toEqual(upstream(false));
    }
  });

  it("logs status and request id but never the message or the key", () => {
    const logger = new MemoryLogger();
    const error = Anthropic.APIError.generate(
      401,
      { error: { message: "bad key sk-ant-fake-test-key" } },
      "bad key sk-ant-fake-test-key",
      new Headers({ "request-id": "req_123" }),
    );
    mapLlmError(error, logger);
    expect(logger.entries).toHaveLength(1);
    const logged = JSON.stringify(logger.entries[0]);
    expect(logged).toContain("401");
    expect(logged).toContain("req_123");
    expect(logged).not.toContain("sk-ant-fake-test-key");
  });
});
