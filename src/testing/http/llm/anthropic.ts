import { http, HttpResponse } from "msw";
import { server } from "../server";
import type { LlmStep, LlmTransport, RecordedRequest } from "./transport";
import { FAST_RETRY_HEADERS } from "./transport";

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

const sse = (events: { type: string; [key: string]: unknown }[]) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/** A real-shaped `POST /v1/messages` streaming response. */
export function anthropicStream(input: {
  text?: string;
  stopReason: string;
  stopDetails?: { type: "refusal"; category: string | null } | null;
  model?: string;
}): Response {
  const events: { type: string; [key: string]: unknown }[] = [
    {
      type: "message_start",
      message: {
        id: "msg_fixture_1",
        type: "message",
        role: "assistant",
        model: input.model ?? "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
  if (input.text !== undefined) {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: input.text } },
      { type: "content_block_stop", index: 0 },
    );
  }
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: input.stopReason,
        stop_sequence: null,
        stop_details: input.stopDetails ?? null,
      },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  );
  return new HttpResponse(sse(events), {
    headers: { "content-type": "text/event-stream", "request-id": "req_fixture_1" },
  });
}

export function anthropicErrorResponse(status: number): Response {
  return HttpResponse.json(
    {
      type: "error",
      error: { type: ERROR_TYPES[status] ?? "api_error", message: `fixture error ${status}` },
      request_id: "req_fixture_err",
    },
    { status, headers: FAST_RETRY_HEADERS },
  );
}

function render(step: LlmStep): Response {
  switch (step.kind) {
    case "json":
      return anthropicStream({ text: JSON.stringify(step.value), stopReason: "end_turn" });
    case "raw":
      return anthropicStream({ text: step.text, stopReason: "end_turn" });
    case "refusal":
      return anthropicStream({
        text: step.text,
        stopReason: "refusal",
        stopDetails: { type: "refusal", category: step.category ?? "cyber" },
      });
    case "truncated":
      return anthropicStream({ text: '{"summary":"cut of', stopReason: "max_tokens" });
    case "http":
      return anthropicErrorResponse(step.status);
    case "network":
      return Response.error();
  }
}

/** Intercepts `POST https://api.anthropic.com/v1/messages`. Call once per test. */
export function anthropicTransport(): LlmTransport {
  const requests: RecordedRequest[] = [];
  const headers: Record<string, string>[] = [];
  const transport: LlmTransport = {
    name: "anthropic",
    baseURL: "https://api.anthropic.com",
    apiKey: "sk-ant-fake-test-key",
    requests,
    headers,
    script(...steps) {
      server.use(
        http.post("https://api.anthropic.com/v1/messages", async ({ request }) => {
          headers.push(Object.fromEntries(request.headers));
          requests.push((await request.json()) as RecordedRequest);
          const step = steps[Math.min(requests.length, steps.length) - 1]!;
          return render(step);
        }),
      );
    },
  };
  return transport;
}
