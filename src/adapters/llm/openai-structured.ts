import OpenAI from "openai";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { Logger } from "../../ports/system";
import { mapLlmError } from "./errors";
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  OPENAI_MAX_OUTPUT_TOKENS,
  type LlmCallOptions,
  type OpenAiAdapterOptions,
} from "./options";

export interface ToolRequest {
  /** Becomes the `instructions` (system) text when present. */
  instructions?: string;
  input: string;
  tool: OpenAI.Responses.FunctionTool;
}

const upstream = (retryable: boolean): { ok: false; error: DomainError } =>
  err({ kind: "upstream", service: "llm", retryable });

/**
 * One forced-function-call request against the OpenAI Responses API, shared by the three OpenAI
 * adapters. Request semantics are unchanged from the legacy code: the model, reasoning effort,
 * output limit, tool and forced `tool_choice`. Only typed-error mapping and an incomplete or
 * refused response check are new. Returns the tool arguments (or the plain text when the relay
 * ignored the tool) as text. Never throws. Validating the text is the caller's job.
 */
export class OpenAiTool {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly reasoningEffort: OpenAI.ReasoningEffort;
  private readonly maxOutputTokens: number;
  private readonly logger?: Logger;

  constructor(
    options: OpenAiAdapterOptions,
    defaults: { reasoningEffort: OpenAI.ReasoningEffort },
  ) {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) throw new Error("OpenAI adapter requires apiKey.");
    // Every env-backed option is passed explicitly: given `undefined`, the SDK would read
    // OPENAI_BASE_URL, OPENAI_ADMIN_KEY, OPENAI_ORG_ID, OPENAI_PROJECT_ID and OPENAI_WEBHOOK_SECRET
    // from process.env,
    // and adapters never read the environment (architecture §6).
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL?.trim() || DEFAULT_OPENAI_BASE_URL,
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
    this.model = options.model?.trim() || DEFAULT_OPENAI_MODEL;
    this.reasoningEffort = options.reasoningEffort ?? defaults.reasoningEffort;
    this.maxOutputTokens = options.maxOutputTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
    this.logger = options.logger;
  }

  async call(
    request: ToolRequest,
    options: LlmCallOptions = {},
  ): Promise<Result<string, DomainError>> {
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create(
        {
          model: this.model,
          reasoning: { effort: this.reasoningEffort },
          // Reasoning tokens count toward this limit.
          max_output_tokens: this.maxOutputTokens,
          tools: [request.tool],
          tool_choice: { type: "function", name: request.tool.name },
          ...(request.instructions ? { instructions: request.instructions } : {}),
          input: request.input,
        },
        options.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      return err(mapLlmError(error, this.logger, OpenAI));
    }

    const incomplete = response.incomplete_details?.reason;
    if (incomplete === "max_output_tokens") {
      this.logger?.warn("llm output hit the token limit", { model: response.model });
      return upstream(true);
    }
    if (incomplete === "content_filter") return upstream(false);
    if (response.status === "failed") return upstream(true);

    for (const item of response.output) {
      if (item.type === "message" && item.content.some((part) => part.type === "refusal")) {
        this.logger?.warn("llm refused the request", { model: response.model });
        return upstream(false);
      }
    }
    const call = response.output.find(
      (item) => item.type === "function_call" && item.name === request.tool.name,
    );
    if (call?.type === "function_call") return ok(call.arguments);
    // Relays that ignore tool_choice answer with text. The caller validates it like any output.
    return ok(response.output_text);
  }
}
