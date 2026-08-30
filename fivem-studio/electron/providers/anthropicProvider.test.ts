import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicProvider,
  describeUsage,
  listAnthropicModels,
  thinkingConfig,
} from "./anthropicProvider";

test("Anthropic model discovery refuses to issue a request without a key", async () => {
  assert.deepEqual(await listAnthropicModels(""), { ok: false, error: "No Anthropic API key set." });
  assert.deepEqual(await listAnthropicModels("   "), { ok: false, error: "No Anthropic API key set." });
});

test("Anthropic provider validates its configured key and model before network access", async () => {
  const missingKeyEvents: Array<{ type: string; message?: string }> = [];
  await new AnthropicProvider({ apiKey: "", model: "claude-custom" })
    .runTurn("hello", (event) => missingKeyEvents.push(event));
  assert.match(missingKeyEvents[0]?.message ?? "", /No Anthropic API key/);

  const missingModelEvents: Array<{ type: string; message?: string }> = [];
  await new AnthropicProvider({ apiKey: "sk-ant-test", model: "   " })
    .runTurn("hello", (event) => missingModelEvents.push(event));
  assert.match(missingModelEvents[0]?.message ?? "", /No Anthropic model/);
});

test("Anthropic thinking policy follows discovered model capabilities", () => {
  assert.deepEqual(thinkingConfig({ thinking: { adaptive: true, enabled: true } }, 32_000), {
    type: "adaptive",
    display: "summarized",
  });
  assert.deepEqual(thinkingConfig({ thinking: { adaptive: false, enabled: true } }, 8_192), {
    type: "enabled",
    budget_tokens: 8_191,
    display: "summarized",
  });
  assert.equal(thinkingConfig({ thinking: { adaptive: false, enabled: true } }, 1_024), undefined);
  assert.equal(thinkingConfig({}, 32_000), undefined);
});

test("Anthropic usage preserves cache buckets and prices only the known default model", () => {
  const usage = {
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 400,
  };
  const known = describeUsage(usage as never, "claude-opus-5", { contextWindow: 1_000_000 });
  assert.deepEqual(known, {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheWriteTokens: 400,
    contextTokens: 1_700,
    contextWindow: 1_000_000,
    costUsd: (1_000 * 5 + 200 * 25 + 400 * 6.25 + 300 * 0.5) / 1_000_000,
  });
  assert.equal(describeUsage(usage as never, "claude-custom", {}).costUsd, undefined);
});
