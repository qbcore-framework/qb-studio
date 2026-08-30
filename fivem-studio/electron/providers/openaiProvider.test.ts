import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { listModels, normalizeOpenAIModelId, ollamaProbeEndpoint, OpenAICompatibleProvider } from "./openaiProvider";

async function localServer(
  t: test.TestContext,
  handler: http.RequestListener,
): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

function sendChunkedOverflow(
  response: http.ServerResponse,
  chunkBytes: number,
  totalChunks: number,
  onChunk?: () => void,
  intervalMs = 1,
): void {
  response.writeHead(200, { "content-type": "application/json" });
  let sent = 0;
  const timer = setInterval(() => {
    if (response.destroyed) {
      clearInterval(timer);
      return;
    }
    sent += 1;
    onChunk?.();
    response.write(Buffer.alloc(chunkBytes, 0x20));
    if (sent >= totalChunks) {
      clearInterval(timer);
      response.end();
    }
  }, intervalMs);
  response.once("close", () => clearInterval(timer));
}

test("builds Ollama probes only for exact numeric loopback URLs", () => {
  assert.equal(ollamaProbeEndpoint("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/api/show");
  assert.equal(ollamaProbeEndpoint("http://127.12.34.56:11434/custom/v1"), "http://127.12.34.56:11434/api/show");
  assert.equal(ollamaProbeEndpoint("http://[::1]:11434/v1"), "http://[::1]:11434/api/show");
  for (const unsafe of [
    "http://localhost:11434/v1",
    "https://127.0.0.1.example/v1",
    "https://example.test/127.0.0.1/v1",
    "http://user:secret@127.0.0.1:11434/v1",
    "not a url",
  ]) {
    assert.equal(ollamaProbeEndpoint(unsafe), null, unsafe);
  }
});

test("bounds and deduplicates model ids and caps Ollama probe concurrency", async (t) => {
  let activeProbes = 0;
  let maximumActiveProbes = 0;
  let probeCount = 0;
  const baseUrl = await localServer(t, (request, response) => {
    if (request.url === "/v1/models") {
      const data = [
        { id: " model-000 ", object: "model", created: 0, owned_by: "test" },
        { id: "model-000", object: "model", created: 0, owned_by: "test" },
        { id: `too-long-${"x".repeat(300)}`, object: "model", created: 0, owned_by: "test" },
        { id: "control\u0000id", object: "model", created: 0, owned_by: "test" },
        ...Array.from({ length: 600 }, (_, index) => ({
          id: `model-${String(index).padStart(3, "0")}`,
          object: "model",
          created: 0,
          owned_by: "test",
        })),
      ];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data }));
      return;
    }
    if (request.url === "/api/show") {
      probeCount += 1;
      activeProbes += 1;
      maximumActiveProbes = Math.max(maximumActiveProbes, activeProbes);
      setTimeout(() => {
        activeProbes -= 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ capabilities: ["tools"] }));
      }, 10);
      return;
    }
    response.writeHead(404).end();
  });

  const result = await listModels(baseUrl, "");
  assert.equal(result.ok, true);
  assert.equal(result.models?.length, 500);
  assert.equal(new Set(result.models).size, 500);
  assert.equal(result.models?.includes("model-000"), true);
  assert.equal(result.models?.some((id) => id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)), false);
  assert.equal(probeCount, 24);
  assert.ok(maximumActiveProbes <= 4, `observed ${maximumActiveProbes} concurrent probes`);
  assert.equal(Object.keys(result.toolCapable ?? {}).length, 24);
});

test("only Gemini removes the API-specific models/ prefix", () => {
  assert.equal(
    normalizeOpenAIModelId("https://generativelanguage.googleapis.com/v1beta/openai/", "models/gemini-test"),
    "gemini-test",
  );
  assert.equal(normalizeOpenAIModelId("https://custom.example/v1", "models/literal-id"), "models/literal-id");
  assert.equal(normalizeOpenAIModelId("http://127.0.0.1:11434/v1", "models/local-id"), "models/local-id");
});

test("model listing does not retry a failed request", async (t) => {
  let requests = 0;
  const reflectedSecret = "Bearer sk-reflected-secret";
  const baseUrl = await localServer(t, (_request, response) => {
    requests += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: reflectedSecret, type: "server_error" } }));
  });

  const result = await listModels(baseUrl, "");
  assert.equal(result.ok, false);
  assert.equal(requests, 1);
  assert.equal(result.error?.includes(reflectedSecret), false);
});

test("keyless model discovery sends no Authorization header", async (t) => {
  const authorizations: Array<string | undefined> = [];
  const baseUrl = await localServer(t, (request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: "local-model", object: "model", created: 0, owned_by: "local" }],
      }));
      return;
    }
    response.writeHead(404).end();
  });

  const result = await listModels(baseUrl, "");

  assert.deepEqual(result.models, ["local-model"]);
  assert.ok(authorizations.length >= 1);
  assert.ok(authorizations.every((value) => value === undefined));
});

test("keyless chat sends no Authorization header", async (t) => {
  const authorizations: Array<string | undefined> = [];
  const baseUrl = await localServer(t, (request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"id":"chatcmpl-local","object":"chat.completion.chunk","created":0,"model":"local-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      );
      return;
    }
    response.writeHead(404).end();
  });
  const provider = new OpenAICompatibleProvider({ baseUrl, model: "local-model", apiKey: "" });
  const events: Array<{ type: string }> = [];

  await provider.runTurn("Say ok.", (event) => events.push(event));

  assert.ok(events.some((event) => event.type === "text"));
  assert.ok(authorizations.length >= 1);
  assert.ok(authorizations.every((value) => value === undefined));
});

test("keyed model discovery preserves the configured Authorization header", async (t) => {
  let authorization: string | undefined;
  const baseUrl = await localServer(t, (request, response) => {
    if (request.url === "/v1/models") authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: "hosted-model", object: "model", created: 0, owned_by: "hosted" }],
    }));
  });

  const result = await listModels(baseUrl, "sk-hosted-test");

  assert.deepEqual(result.models, ["hosted-model"]);
  assert.equal(authorization, "Bearer sk-hosted-test");
});

test("model discovery never follows a redirect away from the configured endpoint", async (t) => {
  let redirectedRequests = 0;
  const redirectTarget = await localServer(t, (_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [] }));
  });
  const configuredEndpoint = await localServer(t, (_request, response) => {
    response.writeHead(307, { location: `${redirectTarget}/models` });
    response.end();
  });

  const result = await listModels(configuredEndpoint, "sk-must-stay-at-configured-endpoint");

  assert.equal(result.ok, false);
  assert.equal(redirectedRequests, 0);
});

test("chat never follows a redirect away from a loopback connection", async (t) => {
  let redirectedRequests = 0;
  const redirectTarget = await localServer(t, (_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [] }));
  });
  const configuredEndpoint = await localServer(t, (_request, response) => {
    response.writeHead(307, { location: `${redirectTarget}/chat/completions` });
    response.end();
  });
  const events: Array<{ type: string; message?: string }> = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: configuredEndpoint,
    model: "local-test-model",
    apiKey: "",
  });

  await provider.runTurn("Do not leave the configured loopback endpoint.", (event) => events.push(event));

  assert.equal(redirectedRequests, 0);
  assert.equal(events.some((event) => event.type === "error"), true);
});

test("cancels an oversized chunked model-list response while it is streaming", async (t) => {
  let chunksWritten = 0;
  const baseUrl = await localServer(t, (_request, response) => {
    sendChunkedOverflow(response, 64 * 1024, 40, () => { chunksWritten += 1; });
  });

  const result = await listModels(baseUrl, "");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /1048576-byte limit/);
  assert.ok(chunksWritten < 40, `server wrote all ${chunksWritten} chunks instead of observing cancellation`);
});

test("cancels an oversized chunked Ollama probe without hiding the model list", async (t) => {
  let probeChunks = 0;
  const baseUrl = await localServer(t, (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: "model-a", object: "model", created: 0, owned_by: "test" }],
      }));
      return;
    }
    if (request.url === "/api/show") {
      sendChunkedOverflow(response, 32 * 1024, 10, () => { probeChunks += 1; }, 10);
      return;
    }
    response.writeHead(404).end();
  });

  const result = await listModels(baseUrl, "");
  assert.deepEqual(result.models, ["model-a"]);
  assert.equal(result.toolCapable, undefined);
  assert.ok(probeChunks < 10, `server wrote all ${probeChunks} chunks instead of observing cancellation`);
});
