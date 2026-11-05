import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { Logger } from "../../ports/system";
import { mapLlmError } from "./errors";
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TOKENS,
  type AnthropicAdapterOptions,
  type AnthropicEffort,
  type LlmCallOptions,
} from "./options";

export type AnthropicMessageParam = Anthropic.Beta.BetaMessageParam;

export interface StructuredRequest {
  /** Omitted from the request when empty. */
  system?: string;
  messages: AnthropicMessageParam[];
  /** JSON Schema of the one JSON object the model must answer with. */
  schema: Record<string, unknown>;
}

const upstream = (retryable: boolean): { ok: false; error: DomainError } =>
  err({ kind: "upstream", service: "llm", retryable });

/**
 * The SDK client options for an adapter configuration. Pure, so it is unit-testable.
 *
 * Credential type alone determines authentication. Explicit nulls prevent the SDK from reading
 * alternate credentials from the environment and suppress the unintended header.
 */
export function buildAnthropicClientOptions(options: AnthropicAdapterOptions): ClientOptions {
  const authToken = options.authToken?.trim();
  const apiKey = options.apiKey?.trim();
  const shared: ClientOptions = {
    // Never undefined: the SDK would fall back to process.env.ANTHROPIC_BASE_URL.
    baseURL: options.baseURL?.trim() || DEFAULT_ANTHROPIC_BASE_URL,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  };
  // Gateway / proxy style: Bearer token, and no x-api-key.
  if (authToken)
    return { authToken, apiKey: null, defaultHeaders: { "x-api-key": null }, ...shared };
  if (apiKey)
    return {
      apiKey,
      authToken: null,
      defaultHeaders: { Authorization: null, "x-api-key": apiKey },
      ...shared,
    };
  throw new Error("Anthropic adapter requires apiKey or authToken.");
}

function createClient(options: AnthropicAdapterOptions): Anthropic {
  const clientOptions = buildAnthropicClientOptions(options);
  return options.clientFactory
    ? options.clientFactory(clientOptions)
    : new Anthropic(clientOptions);
}

/**
 * One structured-output call against Anthropic, shared by the three Anthropic adapters.
 *
 * - Structured outputs (`output_config.format`), not a forced tool: current models reject
 *   `tool_choice` of type `tool` or `any` with a 400.
 * - `output_config.effort` is always set. `thinking` and `budget_tokens` are never sent.
 * - Streams (`beta.messages.stream` + `finalMessage`) so long outputs do not hit HTTP timeouts.
 * - `stop_reason` is checked before any content is read.
 *
 * Returns the model's text, or an `upstream` error. Never throws. Validating the text is the
 * caller's job.
 */
export class AnthropicStructured {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: AnthropicEffort;
  private readonly maxTokens: number;
  private readonly logger?: Logger;

  constructor(options: AnthropicAdapterOptions, defaultEffort: AnthropicEffort) {
    this.client = createClient(options);
    this.model = options.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    this.effort = options.effort ?? defaultEffort;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.logger = options.logger;
  }

  async call(
    request: StructuredRequest,
    options: LlmCallOptions = {},
  ): Promise<Result<string, DomainError>> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client.beta.messages
        .stream(
          {
            model: this.model,
            max_tokens: this.maxTokens,
            ...(request.system ? { system: request.system } : {}),
            messages: request.messages,
            output_config: {
              effort: this.effort,
              format: { type: "json_schema", schema: request.schema },
            },
          },
          options.signal ? { signal: options.signal } : undefined,
        )
        .finalMessage();
    } catch (error) {
      return err(mapLlmError(error, this.logger));
    }

    switch (message.stop_reason) {
      case "refusal":
        this.logger?.warn("llm refused the request", {
          category: message.stop_details?.category ?? null,
          model: message.model,
        });
        return upstream(false);
      case "max_tokens":
        this.logger?.warn("llm output hit the token limit", { model: message.model });
        return upstream(true);
      case "model_context_window_exceeded":
        return upstream(false);
      case "pause_turn":
        return upstream(true);
      default:
        break;
    }

    return ok(
      message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  }
}
