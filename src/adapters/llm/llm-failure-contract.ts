import { describe, expect, it } from "vitest";
import type { DomainError, Result } from "../../domain/shared/result";
import type { LlmTransport } from "../../testing/http/llm";

/** One provider's way to build the port under test against a scripted transport. */
export interface ProviderCase<Port> {
  name: "anthropic" | "openai";
  transport: () => LlmTransport;
  make: (transport: LlmTransport, extra?: Record<string, unknown>) => Port;
}

const upstream = (retryable: boolean): DomainError => ({
  kind: "upstream",
  service: "llm",
  retryable,
});

/**
 * Behaviour every LLM port must show with every provider: output validation fails closed, and
 * provider failures map to `upstream` with the right `retryable` flag. All through msw.
 */
export function describeLlmFailureContract<Port>(
  title: string,
  providers: readonly ProviderCase<Port>[],
  call: (port: Port) => Promise<Result<unknown, DomainError>>,
  options: { valid: unknown; invalid: readonly unknown[] },
) {
  describe.each(providers)(`$name ${title}: failure contract`, (provider) => {
    const setup = (extra?: Record<string, unknown>) => {
      const transport = provider.transport();
      return { transport, port: provider.make(transport, extra) };
    };

    it("a valid structured output is accepted", async () => {
      const { transport, port } = setup();
      transport.script({ kind: "json", value: options.valid });
      expect((await call(port)).ok).toBe(true);
    });

    it("malformed JSON is a validation error", async () => {
      const { transport, port } = setup();
      transport.script({ kind: "raw", text: '{"summary": "unterminated' });
      const result = await call(port);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("validation");
    });

    it.each(options.invalid.map((value, index) => [index, value] as const))(
      "schema-invalid output #%i is a validation error",
      async (_index, value) => {
        const { transport, port } = setup();
        transport.script({ kind: "json", value });
        const result = await call(port);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind).toBe("validation");
      },
    );

    it("a refusal is upstream and not retryable", async () => {
      const { transport, port } = setup();
      transport.script({ kind: "refusal" });
      expect(await call(port)).toEqual({ ok: false, error: upstream(false) });
      expect(transport.requests).toHaveLength(1);
    });

    it("output cut off at the token limit is upstream and retryable", async () => {
      const { transport, port } = setup();
      transport.script({ kind: "truncated" });
      expect(await call(port)).toEqual({ ok: false, error: upstream(true) });
    });

    it.each([
      [429, true],
      [500, true],
      [503, true],
      [529, true],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
    ])("HTTP %i is upstream, retryable=%s", async (status, retryable) => {
      const { transport, port } = setup();
      transport.script({ kind: "http", status });
      expect(await call(port)).toEqual({ ok: false, error: upstream(retryable) });
    });

    it("429 is retried by the SDK (default maxRetries) before it is reported", async () => {
      const { transport, port } = setup();
      transport.script({ kind: "http", status: 429 });
      await call(port);
      expect(transport.requests.length).toBeGreaterThan(1);
    });

    it("400 is not retried", async () => {
      const { transport, port } = setup();
      transport.script({ kind: "http", status: 400 });
      await call(port);
      expect(transport.requests).toHaveLength(1);
    });

    it("a recovered 429 yields the result", async () => {
      const { transport, port } = setup();
      transport.script({ kind: "http", status: 429 }, { kind: "json", value: options.valid });
      expect((await call(port)).ok).toBe(true);
    });

    it("a dropped connection is upstream and retryable", async () => {
      // One retry only: connection errors carry no retry-after, so backoff is real time.
      const { transport, port } = setup({ maxRetries: 1 });
      transport.script({ kind: "network" });
      expect(await call(port)).toEqual({ ok: false, error: upstream(true) });
    });
  });
}
