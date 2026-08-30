import assert from "node:assert/strict";
import test from "node:test";

import { canonicalAgentEndpoint, isGeminiOpenAIEndpoint, isKnownKeyedOpenAIEndpoint } from "./agentProviderPolicy";

test("known hosted endpoints match canonical URL equivalents", () => {
  const equivalent = "https://GENERATIVELANGUAGE.googleapis.com:443/v1beta/other/../openai";
  assert.equal(canonicalAgentEndpoint(equivalent), "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(isKnownKeyedOpenAIEndpoint(equivalent), true);
  assert.equal(isGeminiOpenAIEndpoint(equivalent), true);
  assert.equal(isKnownKeyedOpenAIEndpoint("https://custom.example/v1"), false);
  assert.equal(isGeminiOpenAIEndpoint("https://custom.example/v1"), false);
});

test("embedded credentials and invalid URLs never match a built-in endpoint", () => {
  assert.equal(canonicalAgentEndpoint("https://key@example.com/v1"), null);
  assert.equal(canonicalAgentEndpoint("not a url"), null);
  assert.equal(isKnownKeyedOpenAIEndpoint("https://key@generativelanguage.googleapis.com/v1beta/openai"), false);
});
