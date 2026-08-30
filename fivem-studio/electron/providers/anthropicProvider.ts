// Hosted Claude backend.
//
// Uses a manual streaming loop rather than the SDK's tool runner: the tool set
// is discovered at runtime from the MCP server (so there are no static schemas
// to hand betaZodTool at build time), and the chat UI needs each tool call and
// result surfaced as its own transcript entry as it happens.

import Anthropic from "@anthropic-ai/sdk";

import {
  MAX_ITERATIONS,
  SYSTEM_PROMPT,
  allToolDefinitions,
  parseToolArguments,
  runToolCall,
  type ChatProvider,
  type Emit,
  type TurnUsage,
} from "./types";

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
}

export interface AnthropicModelMetadata {
  /** Maximum input context reported by Anthropic's Models API. */
  contextWindow?: number;
  /** Maximum accepted `max_tokens` value reported by the Models API. */
  maxOutputTokens?: number;
  /** Thinking modes explicitly advertised by the model. */
  thinking?: {
    adaptive: boolean;
    enabled: boolean;
  };
}

export interface AnthropicModelsResult {
  ok: boolean;
  models?: string[];
  modelMetadata?: Record<string, AnthropicModelMetadata>;
  error?: string;
}

const PREFERRED_MAX_TOKENS = 32_000;
/** Conservative fallback when model discovery is unavailable. */
const UNKNOWN_MODEL_MAX_TOKENS = 8_192;
const MODEL_METADATA_TIMEOUT_MS = 5_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const MAX_DISCOVERED_MODELS = 500;
const MAX_MODEL_ID_LENGTH = 256;

/**
 * This is only a fallback for the previously bundled default. Other models get
 * their limits and thinking modes from the Models API or omit those claims.
 */
const KNOWN_MODEL_METADATA: Readonly<Record<string, AnthropicModelMetadata>> = {
  "claude-opus-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    thinking: { adaptive: true, enabled: true },
  },
};

/**
 * claude-opus-5 list price in USD per million tokens. Cache writes bill at
 * 1.25x the input rate and cache reads at 0.1x, so the two cache buckets can't
 * just be folded into the input rate.
 */
const PRICE_PER_MTOK = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

function positiveInteger(value: number | null): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function describeModel(model: Anthropic.ModelInfo): AnthropicModelMetadata {
  const contextWindow = positiveInteger(model.max_input_tokens);
  const maxOutputTokens = positiveInteger(model.max_tokens);
  const thinking = model.capabilities?.thinking;
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(thinking
      ? {
          thinking: {
            adaptive: thinking.supported && thinking.types.adaptive.supported,
            enabled: thinking.supported && thinking.types.enabled.supported,
          },
        }
      : {}),
  };
}

function modelListError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limited the model request. Wait a moment and retry.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `Anthropic could not list models (${err.status}).`;
  return "Could not load Anthropic models.";
}

/** Lists the models available to one immutable Anthropic connection. */
export async function listAnthropicModels(apiKey: string): Promise<AnthropicModelsResult> {
  if (!apiKey.trim()) return { ok: false, error: "No Anthropic API key set." };

  try {
    const client = new Anthropic({ apiKey });
    const metadataById = new Map<string, AnthropicModelMetadata>();
    for await (const model of client.models.list({}, { signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) })) {
      if (metadataById.size >= MAX_DISCOVERED_MODELS) break;
      if (typeof model.id !== "string") continue;
      const id = model.id.trim();
      if (
        !id ||
        id.length > MAX_MODEL_ID_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(id) ||
        metadataById.has(id)
      ) {
        continue;
      }
      metadataById.set(id, describeModel(model));
    }
    if (metadataById.size === 0) return { ok: false, error: "Anthropic returned no models." };

    const models = [...metadataById.keys()].sort((left, right) => left.localeCompare(right));
    return {
      ok: true,
      models,
      modelMetadata: Object.fromEntries(models.map((id) => [id, metadataById.get(id)!])),
    };
  } catch (err) {
    return { ok: false, error: modelListError(err) };
  }
}

export class AnthropicProvider implements ChatProvider {
  private history: Anthropic.MessageParam[] = [];
  private cancelled = false;
  private activeStream: ReturnType<Anthropic.Messages["stream"]> | null = null;
  private metadataController: AbortController | null = null;
  private metadataPromise: Promise<AnthropicModelMetadata> | null = null;

  private readonly options: Readonly<AnthropicProviderOptions>;

  constructor(options: AnthropicProviderOptions) {
    this.options = Object.freeze({
      apiKey: options.apiKey,
      model: options.model.trim(),
    });
  }

  reset(): void {
    this.history = [];
  }

  cancel(): void {
    this.cancelled = true;
    this.metadataController?.abort();
    this.activeStream?.abort();
  }

  async runTurn(userMessage: string, emit: Emit): Promise<void> {
    if (!this.options.apiKey.trim()) {
      emit({
        type: "error",
        message: "No Anthropic API key set — add one in Settings, or switch to a provider with a free tier.",
      });
      return;
    }
    if (!this.options.model) {
      emit({ type: "error", message: "No Anthropic model set — choose one in Settings." });
      return;
    }

    this.cancelled = false;
    const client = new Anthropic({ apiKey: this.options.apiKey });
    const tools = allToolDefinitions();
    const modelMetadata = await this.getModelMetadata(client);
    if (this.cancelled) return;
    const maxTokens = Math.min(
      PREFERRED_MAX_TOKENS,
      modelMetadata.maxOutputTokens ?? UNKNOWN_MODEL_MAX_TOKENS,
    );
    const thinking = thinkingConfig(modelMetadata, maxTokens);

    // Work against a turn-local copy. Cancellation or an API failure can occur
    // after a user message or assistant tool call has been appended; committing
    // that partial shape would make the next request invalid or misleading.
    const turnHistory = [...this.history, { role: "user" as const, content: userMessage }];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (this.cancelled) return;

        const stream = client.messages.stream({
          model: this.options.model,
          max_tokens: maxTokens,
          // Older and smaller Claude models do not all support adaptive
          // thinking. Only send a mode explicitly advertised by Models API.
          ...(thinking ? { thinking } : {}),
          system: SYSTEM_PROMPT,
          tools,
          messages: turnHistory,
        });
        this.activeStream = stream;

        stream.on("text", (delta) => emit({ type: "text", text: delta }));
        stream.on("thinking", (delta) => emit({ type: "thinking", text: delta }));

        const message = await stream.finalMessage();
        this.activeStream = null;
        // Reported before the cancel check: those tokens were billed whether or
        // not the user is still waiting on the answer.
        emit({
          type: "usage",
          usage: describeUsage(message.usage, this.options.model, modelMetadata),
        });
        if (this.cancelled) return;

        // Push the whole content array, not just text: it carries the thinking
        // blocks that must be echoed back unchanged on the next turn.
        turnHistory.push({ role: "assistant", content: message.content });

        if (message.stop_reason === "refusal") {
          this.history = turnHistory;
          emit({
            type: "error",
            message: `Claude declined this request${
              message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."
            }`,
          });
          return;
        }

        // A server-side tool hit its own iteration limit — re-send to continue.
        if (message.stop_reason === "pause_turn") continue;

        const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) {
          this.history = turnHistory;
          return;
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const call of toolUses) {
          const input =
            typeof call.input === "string"
              ? parseToolArguments(call.input)
              : ((call.input ?? {}) as Record<string, unknown>);
          const { content, isError } = await runToolCall(emit, call.id, call.name, input);
          if (this.cancelled) return;
          results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError });
        }

        // All results for one assistant turn go back in a single user message —
        // splitting them teaches the model to stop calling tools in parallel.
        turnHistory.push({ role: "user", content: results });
      }

      // The loop limit is a controlled completion rather than an exception; its
      // last assistant/tool exchange is structurally valid for a follow-up turn.
      this.history = turnHistory;
      emit({ type: "error", message: "Claude reached the agent tool-iteration limit." });
    } catch (err) {
      // abort() from cancel() surfaces here; that's expected, not a failure.
      if (!this.cancelled) emit({ type: "error", message: describeError(err) });
    } finally {
      this.activeStream = null;
    }
  }

  private getModelMetadata(client: Anthropic): Promise<AnthropicModelMetadata> {
    if (this.metadataPromise) return this.metadataPromise;

    this.metadataPromise = (async () => {
      const fallback = KNOWN_MODEL_METADATA[this.options.model] ?? {};
      this.metadataController = new AbortController();
      try {
        const model = await client.models.retrieve(
          this.options.model,
          {},
          {
            signal: AbortSignal.any([
              this.metadataController.signal,
              AbortSignal.timeout(MODEL_METADATA_TIMEOUT_MS),
            ]),
          },
        );
        const discovered = describeModel(model);
        return {
          ...fallback,
          ...discovered,
          thinking: discovered.thinking ?? fallback.thinking,
        };
      } catch {
        // Metadata improves request sizing and thinking selection, but must not
        // prevent a model alias from working when Models API is unavailable.
        if (this.cancelled) this.metadataPromise = null;
        return fallback;
      } finally {
        this.metadataController = null;
      }
    })();
    return this.metadataPromise;
  }
}

/** @internal Exported for request-policy regression tests. */
export function thinkingConfig(
  metadata: AnthropicModelMetadata,
  maxTokens: number,
): Anthropic.ThinkingConfigParam | undefined {
  if (metadata.thinking?.adaptive) return { type: "adaptive", display: "summarized" };
  if (!metadata.thinking?.enabled || maxTokens <= 1_024) return undefined;
  return {
    type: "enabled",
    budget_tokens: Math.min(10_000, maxTokens - 1),
    display: "summarized",
  };
}

/** @internal Exported for cross-provider usage-accounting regression tests. */
export function describeUsage(
  usage: Anthropic.Message["usage"],
  model: string,
  metadata: AnthropicModelMetadata,
): TurnUsage {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const knownPrice = model === "claude-opus-5" ? PRICE_PER_MTOK : undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // Anthropic reports the three input buckets as disjoint — input_tokens
    // excludes anything read from or written to cache — so the prompt's real
    // size is their sum, not input_tokens alone.
    contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow } : {}),
    ...(knownPrice
      ? {
          costUsd:
            (inputTokens * knownPrice.input +
              outputTokens * knownPrice.output +
              cacheWriteTokens * knownPrice.cacheWrite +
              cacheReadTokens * knownPrice.cacheRead) /
            1_000_000,
        }
      : {}),
  };
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic rejected the credentials — check the API key in Settings.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Anthropic API. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API — check your network connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `The Anthropic API returned HTTP ${err.status}.`;
  }
  return "The Anthropic request failed.";
}
