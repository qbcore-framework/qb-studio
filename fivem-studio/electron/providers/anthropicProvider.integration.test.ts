import assert from "node:assert/strict";
import test from "node:test";

type NodeModuleLoader = {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};

interface MessageRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: string; content: unknown }>;
}

const apiKeys: string[] = [];
const listCalls: Array<{ signal?: AbortSignal }> = [];
const retrievedModels: string[] = [];
const messageRequests: MessageRequest[] = [];

class FakeAnthropic {
  static AuthenticationError = class AuthenticationError extends Error {};
  static RateLimitError = class RateLimitError extends Error {};
  static APIConnectionError = class APIConnectionError extends Error {};
  static APIError = class APIError extends Error { status = 500; };

  readonly models = {
    list: (_params: unknown, options: { signal?: AbortSignal }) => {
      listCalls.push(options);
      return (async function* modelPages() {
        yield {
          id: "claude-z",
          max_input_tokens: 200_000,
          max_tokens: 8_192,
          capabilities: {
            thinking: {
              supported: true,
              types: { adaptive: { supported: false }, enabled: { supported: true } },
            },
          },
        };
        yield {
          id: " claude-a ",
          max_input_tokens: 100_000,
          max_tokens: 4_096,
        };
      })();
    },
    retrieve: async (model: string) => {
      retrievedModels.push(model);
      return {
        id: model,
        max_input_tokens: 200_000,
        max_tokens: 4_096,
      };
    },
  };

  readonly messages = {
    stream: (request: MessageRequest) => {
      // Capture the request as the real SDK serializes it, before the provider
      // appends the successful response to its turn-local history.
      messageRequests.push({ ...request, messages: [...request.messages] });
      const handlers = new Map<string, (value: string) => void>();
      return {
        on(name: string, handler: (value: string) => void) {
          handlers.set(name, handler);
          return this;
        },
        async finalMessage() {
          handlers.get("text")?.("Hello from mocked Claude");
          return {
            content: [{ type: "text", text: "Hello from mocked Claude" }],
            stop_reason: "end_turn",
            stop_details: null,
            usage: {
              input_tokens: 12,
              output_tokens: 5,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 2,
            },
          };
        },
        abort() {},
      };
    },
  };

  constructor(options: { apiKey: string }) {
    apiKeys.push(options.apiKey);
  }
}

const moduleLoader = require("node:module") as NodeModuleLoader;
const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithFakeAnthropic(request, parent, isMain) {
  if (request === "@anthropic-ai/sdk") return FakeAnthropic;
  return originalLoad.call(this, request, parent, isMain);
};

let anthropicProvider: typeof import("./anthropicProvider");
try {
  anthropicProvider = require("./anthropicProvider") as typeof import("./anthropicProvider");
} finally {
  moduleLoader._load = originalLoad;
}

test.beforeEach(() => {
  apiKeys.length = 0;
  listCalls.length = 0;
  retrievedModels.length = 0;
  messageRequests.length = 0;
});

test("Anthropic model discovery uses the supplied key and returns validated model metadata", async () => {
  const result = await anthropicProvider.listAnthropicModels("sk-ant-discovery-test");

  assert.deepEqual(apiKeys, ["sk-ant-discovery-test"]);
  assert.equal(listCalls.length, 1);
  assert.ok(listCalls[0].signal instanceof AbortSignal);
  assert.deepEqual(result, {
    ok: true,
    models: ["claude-a", "claude-z"],
    modelMetadata: {
      "claude-a": { contextWindow: 100_000, maxOutputTokens: 4_096 },
      "claude-z": {
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        thinking: { adaptive: false, enabled: true },
      },
    },
  });
});

test("Anthropic chat transport uses the configured key and emits a successful streamed response", async () => {
  const events: Array<Record<string, unknown>> = [];
  const provider = new anthropicProvider.AnthropicProvider({
    apiKey: "sk-ant-chat-test",
    model: "claude-chat-test",
  });

  await provider.runTurn("Say hello", (event) => events.push(event as unknown as Record<string, unknown>));

  assert.deepEqual(apiKeys, ["sk-ant-chat-test"]);
  assert.deepEqual(retrievedModels, ["claude-chat-test"]);
  assert.equal(messageRequests.length, 1);
  assert.equal(messageRequests[0].model, "claude-chat-test");
  assert.equal(messageRequests[0].max_tokens, 4_096);
  assert.deepEqual(messageRequests[0].messages, [{ role: "user", content: "Say hello" }]);
  assert.deepEqual(events.find((event) => event.type === "text"), {
    type: "text",
    text: "Hello from mocked Claude",
  });
  assert.deepEqual(events.find((event) => event.type === "usage"), {
    type: "usage",
    usage: {
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      contextTokens: 17,
      contextWindow: 200_000,
    },
  });
  assert.equal(events.some((event) => event.type === "error"), false);
});
