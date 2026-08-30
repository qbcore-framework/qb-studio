// Any OpenAI-compatible chat-completions endpoint.
//
// This one class covers most of the ecosystem, because nearly everyone exposes
// an OpenAI-shaped API: local runtimes (Ollama, LM Studio, llama.cpp, vLLM) and
// hosted providers alike (Google Gemini via its OpenAI-compat layer, Groq,
// OpenRouter, Mistral, DeepSeek, Together, OpenAI itself). Adding a provider is
// therefore usually just a base URL and a model name, not new code.
//
// Caveat this provider can't paper over: the agent is entirely tool-driven, and
// tool-calling quality varies a lot — especially among smaller local models. A
// model without solid tool support will connect fine and then just answer in
// prose, never calling anything. Settings flags that.

import OpenAI from "openai";

import { isLoopbackHostname } from "../localUrl";
import { isGeminiOpenAIEndpoint } from "../agentProviderPolicy";
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

const MODEL_LIST_TIMEOUT_MS = 10_000;
const MAX_DISCOVERED_MODELS = 500;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_OLLAMA_CAPABILITY_PROBES = 24;
const OLLAMA_PROBE_CONCURRENCY = 4;
const OLLAMA_PROBE_TIMEOUT_MS = 3_000;
const MAX_OLLAMA_RESPONSE_BYTES = 64 * 1024;
const MAX_MODEL_LIST_RESPONSE_BYTES = 1024 * 1024;

export interface OpenAIProviderOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Strict servers answer an unrecognized request field with a 400 or 422. */
function rejectsUnknownField(err: unknown): boolean {
  return err instanceof OpenAI.APIError && (err.status === 400 || err.status === 422);
}

function describeUsage(usage: OpenAI.CompletionUsage): TurnUsage {
  const promptTokens = usage.prompt_tokens ?? 0;
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    // Unlike Anthropic, prompt_tokens here is inclusive of the cached tokens.
    // Subtracting keeps inputTokens meaning "billed at full rate" on both
    // providers, so the panel isn't double-counting cache hits on this one.
    inputTokens: Math.max(0, promptTokens - cacheReadTokens),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens,
    // No cache-write accounting in the OpenAI response shape.
    cacheWriteTokens: 0,
    contextTokens: promptTokens,
    // The window size and the per-token price depend on which server is behind
    // this URL, and neither is discoverable from a chat-completions response —
    // so the panel shows raw counts here instead of a percentage or a cost.
  };
}

/**
 * Asks the endpoint what models it serves. Every OpenAI-compatible server
 * implements GET /models, so this works for hosted providers and local runtimes
 * alike — no need to hardcode (and then out-date) model names per provider.
 */
/**
 * Ollama's own API reports per-model capabilities, which the OpenAI-compatible
 * /models endpoint doesn't expose. Since this agent is useless with a model that
 * can't call tools, surface that up front rather than letting the user find out
 * when the model cheerfully chats instead of doing anything.
 *
 * Best effort: any failure just yields no annotations.
 */
export function ollamaProbeEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !isLoopbackHostname(url.hostname)
    ) {
      return null;
    }
    // /v1 is the OpenAI-compat prefix; /api/show lives at the server root.
    return new URL("/api/show", url.origin).toString();
  } catch {
    return null;
  }
}

function isNumericLoopbackUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeOpenAIModelId(baseUrl: string, modelId: string): string {
  return (isGeminiOpenAIEndpoint(baseUrl) ? modelId.replace(/^models\//, "") : modelId).trim();
}

function boundedModelIds(baseUrl: string, models: OpenAI.Models.Model[]): string[] {
  const unique = new Set<string>();
  for (const model of models) {
    if (unique.size >= MAX_DISCOVERED_MODELS) break;
    if (typeof model.id !== "string") continue;
    // Gemini lists ids as "models/gemini-...", while its chat completions
    // endpoint expects the bare id. Other compatible providers may use
    // "models/" literally, so scope this workaround to Gemini's endpoint.
    const id = normalizeOpenAIModelId(baseUrl, model.id);
    if (!id || id.length > MAX_MODEL_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) continue;
    unique.add(id);
  }
  return [...unique].sort((left, right) => left.localeCompare(right));
}

class ResponseSizeLimitError extends Error {
  constructor(maxBytes: number) {
    super(`Model discovery response exceeded the ${maxBytes}-byte limit.`);
    this.name = "ResponseSizeLimitError";
  }
}

/** A configured endpoint is the complete network trust boundary. Following a
 * redirect could move prompts, tool results, or a loopback-only request to a
 * host the user never selected. Reject redirects even though fetch normally
 * strips Authorization on a cross-origin hop. */
const redirectRejectingFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: "error" });

/**
 * The OpenAI SDK requires a non-empty apiKey option and synthesizes an
 * Authorization header from it. Keyless connections still pass a harmless
 * placeholder to satisfy that constructor, but this wrapper removes the
 * resulting header at the final transport boundary. It also handles a Request
 * object carrying headers of its own rather than assuming they live in init.
 */
function connectionFetch(apiKey: string, delegate: typeof fetch): typeof fetch {
  if (apiKey.trim()) return delegate;
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.delete("authorization");
    return delegate(input, { ...init, headers });
  };
}

/**
 * Wrap fetch so consumers cannot buffer an unbounded response before checking
 * its size. The stream is cancelled as soon as either Content-Length or actual
 * bytes cross the limit; chunked and compressed responses are counted as read.
 * Model discovery shares the same no-redirect endpoint boundary as chat.
 */
function responseLimitedFetch(maxBytes: number): typeof fetch {
  return async (input, init) => {
    const response = await redirectRejectingFetch(input, init);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new ResponseSizeLimitError(maxBytes);
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    let bytesRead = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          bytesRead += chunk.value.byteLength;
          if (bytesRead > maxBytes) {
            await reader.cancel();
            controller.error(new ResponseSizeLimitError(maxBytes));
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function probeOllamaToolSupport(baseUrl: string, models: string[]): Promise<Record<string, boolean> | undefined> {
  const endpoint = ollamaProbeEndpoint(baseUrl);
  if (!endpoint) return undefined;

  const targets = models.slice(0, MAX_OLLAMA_CAPABILITY_PROBES);
  const entries: Array<readonly [string, boolean] | null> = Array(targets.length).fill(null);
  let cursor = 0;
  let endpointUnavailable = false;

  try {
    const workers = Array.from(
      { length: Math.min(OLLAMA_PROBE_CONCURRENCY, targets.length) },
      async () => {
        while (!endpointUnavailable) {
          const index = cursor++;
          if (index >= targets.length) return;
          const model = targets[index];
          try {
            const res = await responseLimitedFetch(MAX_OLLAMA_RESPONSE_BYTES)(endpoint, {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body: JSON.stringify({ model }),
              signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
            });
            // A local OpenAI-compatible server need not be Ollama. Stop issuing
            // probes as soon as it definitively lacks Ollama's endpoint.
            if (res.status === 404 || res.status === 405) {
              endpointUnavailable = true;
              return;
            }
            if (!res.ok) continue;
            const body = await res.json() as { capabilities?: unknown } | null;
            if (!body || !Array.isArray(body.capabilities)) continue;
            entries[index] = [model, body.capabilities.includes("tools")];
          } catch {
            // Capability detection is best effort and must not hide models.
          }
        }
      },
    );
    await Promise.all(workers);
    const known = entries.filter((entry): entry is readonly [string, boolean] => entry !== null);
    return known.length > 0 ? Object.fromEntries(known) : undefined;
  } catch {
    return undefined;
  }
}

export async function listModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; models?: string[]; toolCapable?: Record<string, boolean>; error?: string }> {
  if (!baseUrl.trim()) return { ok: false, error: "No server URL set." };
  try {
    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "local",
      maxRetries: 0,
      timeout: MODEL_LIST_TIMEOUT_MS,
      fetch: connectionFetch(apiKey, responseLimitedFetch(MAX_MODEL_LIST_RESPONSE_BYTES)),
    });
    const page = await client.models.list({ signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
    const models = boundedModelIds(baseUrl, page.data);
    if (models.length === 0) return { ok: false, error: "The server returned no models." };

    return { ok: true, models, toolCapable: await probeOllamaToolSupport(baseUrl, models) };
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) return { ok: false, error: "The provider rejected the API key." };
    if (err instanceof OpenAI.APIConnectionError) return { ok: false, error: "Could not reach the model provider." };
    if (err instanceof OpenAI.APIError) return { ok: false, error: `The model provider returned HTTP ${err.status}.` };
    if (err instanceof ResponseSizeLimitError) return { ok: false, error: err.message };
    // Remote response bodies and nested SDK errors are deliberately not exposed:
    // a hostile endpoint could reflect the Authorization header into its error.
    return { ok: false, error: "Could not load models from the provider." };
  }
}

export class OpenAICompatibleProvider implements ChatProvider {
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private cancelled = false;
  private controller: AbortController | null = null;
  /** Set once a server has rejected stream_options, so we stop re-sending it. */
  private usageStreamUnsupported = false;

  private options: OpenAIProviderOptions;

  constructor(options: OpenAIProviderOptions) {
    this.options = {
      ...options,
      // Same "models/" normalization as listModels, applied again here so a
      // config already saved with the prefixed form heals itself instead of
      // failing every turn until someone re-picks the model.
      model: normalizeOpenAIModelId(options.baseUrl, options.model),
    };
  }

  reset(): void {
    this.history = [];
  }

  cancel(): void {
    this.cancelled = true;
    this.controller?.abort();
  }

  async runTurn(userMessage: string, emit: Emit): Promise<void> {
    if (!this.options.baseUrl.trim()) {
      emit({ type: "error", message: "No model server URL set — pick a provider in Settings." });
      return;
    }
    if (!this.options.model.trim()) {
      emit({ type: "error", message: "No model name set — add one in Settings." });
      return;
    }

    this.cancelled = false;
    const client = new OpenAI({
      baseURL: this.options.baseUrl,
      // The SDK requires something non-empty; connectionFetch strips the
      // synthesized Authorization header for a genuinely keyless connection.
      apiKey: this.options.apiKey || "local",
      fetch: connectionFetch(this.options.apiKey, redirectRejectingFetch),
    });

    const tools: OpenAI.Chat.ChatCompletionTool[] = allToolDefinitions().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    // Build the turn against a private copy. A cancelled stream, failed API
    // retry, or interrupted tool loop must not leave a dangling user message or
    // an assistant tool call without all of its matching tool results in the
    // durable conversation used by the next turn.
    const turnHistory: OpenAI.Chat.ChatCompletionMessageParam[] = this.history.length === 0
      ? [{ role: "system", content: SYSTEM_PROMPT }]
      : [...this.history];
    turnHistory.push({ role: "user", content: userMessage });

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (this.cancelled) return;

        this.controller = new AbortController();
        const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model: this.options.model,
          messages: turnHistory,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          // Ollama's OpenAI-compatible endpoint does NOT inherit the
          // Modelfile's temperature: omitting it yields 1.0, verified by
          // seed-matched comparison against /api/chat. On this coder,
          // measured scores were 140/160 at 0.4 versus 118/160 at 0.7, so
          // the default was actively harmful. top_k and repeat_penalty are
          // not OpenAI fields and do still come from the Modelfile.
          temperature: 0.4,
          top_p: 0.8,
        };
        // A streaming response carries no token counts unless asked. Support is
        // not universal across OpenAI-compatible servers, so a rejection
        // downgrades this connection permanently and retries — losing the token
        // readout is acceptable, failing the whole turn over it is not.
        if (!this.usageStreamUnsupported) body.stream_options = { include_usage: true };

        let stream;
        try {
          stream = await client.chat.completions.create(body, { signal: this.controller.signal });
        } catch (err) {
          if (this.cancelled || this.usageStreamUnsupported || !rejectsUnknownField(err)) throw err;
          this.usageStreamUnsupported = true;
          delete body.stream_options;
          stream = await client.chat.completions.create(body, { signal: this.controller.signal });
        }

        // Tool calls arrive as deltas keyed by index, with name and arguments
        // streamed in pieces — accumulate before we can act on any of them.
        let text = "";
        let usage: OpenAI.CompletionUsage | undefined;
        const partialCalls = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();

        for await (const chunk of stream) {
          if (this.cancelled) return;
          // The usage chunk comes last and has an empty choices array, so it
          // has to be read before the delta guard below skips it.
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            text += delta.content;
            emit({ type: "text", text: delta.content });
          }

          for (const call of delta.tool_calls ?? []) {
            const existing = partialCalls.get(call.index) ?? { id: "", name: "", args: "" };
            // Providers may hang extra per-call metadata off the tool call that
            // isn't part of the OpenAI schema, and that must be echoed back
            // verbatim on the next turn. Gemini's thinking models do exactly
            // this with extra_content.google.thought_signature, and dropping it
            // (which a plain OpenAI client does) makes the *next* request fail
            // with a 400 — so carry through whatever we're handed.
            const extra = (call as { extra_content?: unknown }).extra_content;
            partialCalls.set(call.index, {
              id: call.id ?? existing.id,
              name: call.function?.name ?? existing.name,
              args: existing.args + (call.function?.arguments ?? ""),
              extra: extra ?? existing.extra,
            });
          }
        }
        this.controller = null;
        if (usage) emit({ type: "usage", usage: describeUsage(usage) });
        if (this.cancelled) return;

        const calls = [...partialCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, c], n) => ({
            // Some local servers omit tool-call ids; the id only has to be
            // consistent between our request and the follow-up result.
            id: c.id || `call_${i}_${index}_${n}`,
            name: c.name,
            args: c.args,
            extra: c.extra,
          }))
          .filter((c) => c.name);

        turnHistory.push({
          role: "assistant",
          content: text || null,
          ...(calls.length > 0 && {
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.args || "{}" },
              // Cast: extra_content isn't in the OpenAI schema, but it has to go
              // back on the wire untouched for providers that sent it (see above).
              ...(c.extra ? { extra_content: c.extra } : {}),
            })),
          }),
        } as OpenAI.Chat.ChatCompletionMessageParam);

        if (calls.length === 0) {
          this.history = turnHistory;
          return;
        }

        for (const call of calls) {
          const { content } = await runToolCall(emit, call.id, call.name, parseToolArguments(call.args));
          if (this.cancelled) return;
          // The OpenAI format wants one tool message per call, each keyed by id —
          // unlike Anthropic, where all results share a single user message.
          turnHistory.push({ role: "tool", tool_call_id: call.id, content });
        }
      }

      // Reaching the safety limit still leaves a complete assistant/tool-result
      // exchange, so preserve the same follow-up behavior as before.
      this.history = turnHistory;
    } catch (err) {
      if (!this.cancelled) emit({ type: "error", message: this.describeError(err) });
    } finally {
      this.controller = null;
    }
  }

  private describeError(err: unknown): string {
    const isLocal = isNumericLoopbackUrl(this.options.baseUrl);
    if (err instanceof OpenAI.APIConnectionError) {
      return isLocal
        ? `Could not reach the model server at ${this.options.baseUrl}. Is it running? (For Ollama: \`ollama serve\`.)`
        : `Could not reach ${this.options.baseUrl} — check the URL and your network connection.`;
    }
    if (err instanceof OpenAI.AuthenticationError) {
      return "The provider rejected the API key — check it in Settings.";
    }
    if (err instanceof OpenAI.NotFoundError) {
      return isLocal
        ? `The server has no model named "${this.options.model}". (For Ollama: \`ollama pull ${this.options.model}\`.)`
        : `No model named "${this.options.model}" at this provider — check the model name in Settings.`;
    }
    if (err instanceof OpenAI.RateLimitError) {
      return "Rate limited by the provider — free tiers cap requests per minute/day. Wait a moment and retry.";
    }
    if (err instanceof OpenAI.APIError) {
      return `The model provider returned HTTP ${err.status}.`;
    }
    return "The model request failed.";
  }
}
