import assert from "node:assert/strict";
import test from "node:test";

import {
  agentTargetKey,
  agentTargetLabel,
  agentChatResetReasons,
  canStartAgentSend,
  decideAgentTargetSwitch,
  parseAgentTargetKey,
} from "./agentTarget";

const connections = [
  { id: "gemini", label: "Google Gemini", models: ["flash", "pro"] },
  { id: "local", label: "Ollama", models: ["qwen:latest"] },
];

test("target select keys round-trip only configured connection/model pairs", () => {
  const target = { connectionId: "gemini", model: "pro" };
  assert.deepEqual(parseAgentTargetKey(agentTargetKey(target), connections), target);
  assert.equal(parseAgentTargetKey(JSON.stringify(["gemini", "unknown"]), connections), null);
  assert.equal(parseAgentTargetKey(JSON.stringify(["missing", "pro"]), connections), null);
  assert.equal(parseAgentTargetKey("not-json", connections), null);
  assert.equal(parseAgentTargetKey(JSON.stringify({ connectionId: "gemini", model: "pro" }), connections), null);
});

test("switch decisions preserve an active conversation unless the user confirms", () => {
  const current = { connectionId: "gemini", model: "flash" };
  const next = { connectionId: "gemini", model: "pro" };
  assert.equal(decideAgentTargetSwitch({ current, next: current, busy: true, hasTranscript: true }), "no-op");
  assert.equal(decideAgentTargetSwitch({ current, next, busy: true, hasTranscript: false }), "blocked-busy");
  assert.equal(decideAgentTargetSwitch({ current, next, busy: false, hasTranscript: true }), "confirm");
  assert.equal(decideAgentTargetSwitch({ current, next, busy: false, hasTranscript: false }), "switch");
});

test("target labels disambiguate provider connections", () => {
  assert.equal(agentTargetLabel({ connectionId: "gemini", model: "flash" }, connections), "Google Gemini · flash");
  assert.equal(agentTargetLabel({ connectionId: "gone", model: "model" }, connections), "model");
});

test("message submission is blocked throughout an agent-target transition", () => {
  const available = {
    message: "inspect the resource",
    ready: true as const,
    busy: false,
    switchingTarget: false,
    sendLocked: false,
  };
  assert.equal(canStartAgentSend(available), true);
  assert.equal(canStartAgentSend({ ...available, switchingTarget: true }), false);
  assert.equal(canStartAgentSend({ ...available, busy: true }), false);
  assert.equal(canStartAgentSend({ ...available, sendLocked: true }), false);
  assert.equal(canStartAgentSend({ ...available, ready: null }), false);
  assert.equal(canStartAgentSend({ ...available, message: "   " }), false);
});

test("Settings reset reasons track only the active native conversation identity", () => {
  const saved = {
    connections: [
      { id: "gemini", label: "Gemini", models: ["flash", "pro"], provider: "openai", baseUrl: "https://example.com/v1", requiresKey: true },
      { id: "local", label: "Local", models: ["qwen"], provider: "openai", baseUrl: "http://127.0.0.1:11434/v1", requiresKey: false },
    ],
    active: { connectionId: "gemini", model: "flash" },
  };
  assert.deepEqual(agentChatResetReasons(saved, saved, { local: { kind: "replace", value: "inactive-key" } }), []);
  assert.deepEqual(agentChatResetReasons(saved, {
    ...saved,
    active: { connectionId: "gemini", model: "pro" },
  }, {}), ["the active connection or model changed"]);
  assert.deepEqual(agentChatResetReasons(saved, {
    ...saved,
    connections: saved.connections.map((connection) => connection.id === "gemini"
      ? { ...connection, baseUrl: "https://other.example/v1" }
      : connection),
  }, {}), ["the active provider, endpoint, or credential policy changed"]);
  assert.deepEqual(agentChatResetReasons(saved, saved, {
    gemini: { kind: "clear", reason: "explicit" },
  }), ["the active connection’s saved API key changed"]);
});
