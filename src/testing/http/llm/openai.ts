import { http, HttpResponse } from "msw";
import { server } from "../server";
import type { LlmStep, LlmTransport, RecordedRequest } from "./transport";
import { FAST_RETRY_HEADERS } from "./transport";

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "invalid_request_error",
  403: "invalid_request_error",
  404: "invalid_request_error",
  429: "rate_limit_error",
  500: "server_error",
};

/** A real-shaped `POST /v1/responses` body (the Responses API). */
function envelope(request: RecordedRequest, partial: Record<string, unknown>) {
  return {
    id: "resp_fixture_1",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: request.model ?? "gpt-6.1-sol",
    error: null,
    incomplete_details: null,
    output: [],
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    ...partial,
  };
}

function toolCall(request: RecordedRequest, args: string) {
  const name = request.tool_choice?.name ?? request.tools?.[0]?.name ?? "unknown_tool";
  return {
    type: "function_call",
    id: "fc_fixture_1",
    call_id: "call_fixture_1",
    name,
    arguments: args,
    status: "completed",
  };
}

function render(step: LlmStep, request: RecordedRequest): Response {
  switch (step.kind) {
    case "json":
      return HttpResponse.json(
        envelope(request, { output: [toolCall(request, JSON.stringify(step.value))] }),
      );
    case "raw":
      return HttpResponse.json(envelope(request, { output: [toolCall(request, step.text)] }));
    case "refusal":
      return HttpResponse.json(
        envelope(request, {
          output: [
            {
              type: "message",
              id: "msg_fixture_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "refusal", refusal: "I can't help with that." }],
            },
          ],
        }),
      );
    case "truncated":
      return HttpResponse.json(
        envelope(request, {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      );
    case "http":
      return HttpResponse.json(
        {
          error: {
            message: `fixture error ${step.status}`,
            type: ERROR_TYPES[step.status] ?? "server_error",
            code: null,
          },
        },
        { status: step.status, headers: FAST_RETRY_HEADERS },
      );
    case "network":
      return Response.error();
  }
}

/** Intercepts `POST https://api.openai.com/v1/responses`. Call once per test. */
export function openaiTransport(): LlmTransport {
  const requests: RecordedRequest[] = [];
  const headers: Record<string, string>[] = [];
  return {
    name: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-fake-test-key",
    requests,
    headers,
    script(...steps) {
      server.use(
        http.post("https://api.openai.com/v1/responses", async ({ request }) => {
          const body = (await request.json()) as RecordedRequest;
          headers.push(Object.fromEntries(request.headers));
          requests.push(body);
          const step = steps[Math.min(requests.length, steps.length) - 1]!;
          return render(step, body);
        }),
      );
    },
  };
}
