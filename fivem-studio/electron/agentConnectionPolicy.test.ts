import assert from "node:assert/strict";
import test from "node:test";

import {
  agentRuntimeSignature,
  requireAgentConnectionId,
  requireAgentConnectionProbe,
  requireAgentCredentialUpdates,
  requireAgentSettings,
  requireAgentSettingsUpdate,
  requireConnectionKey,
  withAgentTarget,
  withCredentialRevision,
} from "./agentConnectionPolicy";
import { MAX_CREDENTIAL_REVISION, normalizeConfig } from "./configStore";

function fixture() {
  const base = normalizeConfig({});
  const local = {
    id: "local",
    label: "Ollama",
    provider: "openai" as const,
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen", "deepseek"],
    requiresKey: false,
  };
  const anthropic = {
    id: "anthropic",
    label: "Anthropic",
    provider: "anthropic" as const,
    baseUrl: "",
    models: ["claude-opus-5"],
    requiresKey: true,
  };
  return {
    ...base,
    agent: { ...base.agent, connections: [...base.agent.connections, local, anthropic] },
  };
}

test("renderer agent settings require bounded unique connections and an owned active model", () => {
  const config = fixture();
  assert.equal(requireAgentSettings(config.agent), config.agent);
  assert.throws(() => requireAgentSettings({ ...config.agent, connections: [] }), /between 1 and 32/);
  assert.throws(() => requireAgentSettings({
    ...config.agent,
    connections: [...config.agent.connections, { ...config.agent.connections[0] }],
  }), /unique valid id/);
  assert.throws(() => requireAgentSettings({
    ...config.agent,
    connections: config.agent.connections.map((connection) => connection.id === "local"
      ? { ...connection, label: config.agent.connections[0].label.toLocaleUpperCase() }
      : connection),
  }), /unique label/);
  assert.throws(() => requireAgentSettings({
    ...config.agent,
    active: { connectionId: "local", model: "missing" },
  }), /selected agent and model/);
  assert.throws(() => requireAgentSettings({
    ...config.agent,
    connections: config.agent.connections.map((connection) => connection.id === "local"
      ? { ...connection, baseUrl: "http://example.com/v1" }
      : connection),
  }), /HTTPS/);
});

test("renderer settings cannot weaken fixed provider credential policy", () => {
  const config = fixture();
  assert.throws(() => requireAgentSettings({
    ...config.agent,
    connections: config.agent.connections.map((connection) => connection.provider === "openai"
      ? connection
      : { ...connection, requiresKey: false }),
  }), /Anthropic connections require/);
  const authenticatedLocal = {
    ...config.agent,
    connections: config.agent.connections.map((connection) => connection.id === "local"
      ? { ...connection, requiresKey: true }
      : connection),
  };
  assert.equal(requireAgentSettings(authenticatedLocal), authenticatedLocal);
  assert.throws(() => requireAgentSettings({
    ...config.agent,
    connections: config.agent.connections.map((connection) => connection.id === config.agent.active.connectionId
      ? { ...connection, requiresKey: false }
      : connection),
  }), /hosted.*require an API key/i);
});

test("settings updates preserve the main-owned credential revision", () => {
  const config = fixture();
  const updated = requireAgentSettingsUpdate({ ...config.agent, credentialRevision: 0 }, 41);
  assert.equal(updated.credentialRevision, 41);
  assert.equal(config.agent.credentialRevision, 0, "the persisted source remains immutable");
  assert.throws(() => requireAgentSettingsUpdate(config.agent, -1), /credential revision/);
});

test("connection probes accept only fixed Anthropic or secure canonical OpenAI endpoints", () => {
  assert.deepEqual(requireAgentConnectionProbe({ provider: "anthropic", baseUrl: "", requiresKey: true }), {
    provider: "anthropic",
    baseUrl: "",
    requiresKey: true,
  });
  assert.throws(
    () => requireAgentConnectionProbe({ provider: "anthropic", baseUrl: "https://attacker.example/v1", requiresKey: true }),
    /cannot override/,
  );
  assert.deepEqual(requireAgentConnectionProbe({ provider: "openai", baseUrl: "https://EXAMPLE.com:443/v1", requiresKey: true }), {
    provider: "openai",
    baseUrl: "https://example.com/v1",
    requiresKey: true,
  });
  assert.deepEqual(requireAgentConnectionProbe({ provider: "openai", baseUrl: "https://no-auth.example/v1", requiresKey: false }), {
    provider: "openai",
    baseUrl: "https://no-auth.example/v1",
    requiresKey: false,
  });
  assert.throws(() => requireAgentConnectionProbe({ provider: "anthropic", baseUrl: "", requiresKey: false }), /require an API key/);
  assert.throws(() => requireAgentConnectionProbe({
    provider: "openai",
    baseUrl: "https://GENERATIVELANGUAGE.googleapis.com:443/v1beta/other/../openai",
    requiresKey: false,
  }), /hosted.*require an API key/i);
  assert.throws(() => requireAgentConnectionProbe({ provider: "openai", baseUrl: "http://example.com/v1", requiresKey: true }), /HTTPS/);
  assert.throws(() => requireAgentConnectionProbe({ provider: "openai", baseUrl: "https://key@example.com/v1", requiresKey: true }), /credentials/);
  assert.deepEqual(
    requireAgentConnectionProbe({ provider: "openai", baseUrl: "http://127.0.0.1:11434/v1", requiresKey: true }),
    { provider: "openai", baseUrl: "http://127.0.0.1:11434/v1", requiresKey: true },
  );
});

test("connection ids and write-only credential input are strict", () => {
  assert.equal(requireAgentConnectionId("account_1-local"), "account_1-local");
  assert.throws(() => requireAgentConnectionId("../account"), /id is invalid/);
  assert.equal(requireConnectionKey(""), "", "empty string is the explicit clear operation");
  assert.equal(requireConnectionKey("sk-valid key"), "sk-valid key");
  for (const invalid of [" key", "key ", "\t", "line\nbreak", "x".repeat(4097), null]) {
    assert.throws(() => requireConnectionKey(invalid), /API key/);
  }
});

test("batched credential changes are unique, configured, bounded, and keyless-safe", () => {
  const settings = fixture().agent;
  assert.deepEqual(requireAgentCredentialUpdates([
    { connectionId: settings.connections[0].id, key: "secret" },
    { connectionId: "local", key: "" },
  ], settings), [
    { connectionId: settings.connections[0].id, key: "secret" },
    { connectionId: "local", key: "" },
  ]);
  assert.throws(() => requireAgentCredentialUpdates([
    { connectionId: settings.connections[0].id, key: "one" },
    { connectionId: settings.connections[0].id, key: "two" },
  ], settings), /only one credential change/i);
  assert.throws(() => requireAgentCredentialUpdates([
    { connectionId: "missing", key: "secret" },
  ], settings), /not being saved/i);
  assert.throws(() => requireAgentCredentialUpdates([
    { connectionId: "local", key: "must-not-send" },
  ], settings), /keyless/i);
});

test("target selection is immutable, validates membership, and changes runtime identity", () => {
  const config = fixture();
  const selected = withAgentTarget(config, "local", "deepseek");
  assert.notEqual(selected, config);
  assert.deepEqual(selected.agent.active, { connectionId: "local", model: "deepseek" });
  assert.notEqual(agentRuntimeSignature(selected), agentRuntimeSignature(config));
  assert.equal(withAgentTarget(selected, "local", "deepseek"), selected);
  assert.throws(() => withAgentTarget(config, "local", "missing"), /no longer configured/);
  assert.throws(() => withAgentTarget(config, "../local", "deepseek"), /id is invalid/);
  assert.throws(() => withAgentTarget(config, "local", " deepseek"), /model is invalid/);
});

test("runtime identity ignores labels/catalogs but includes active endpoint and credentials", () => {
  const config = fixture();
  const signature = agentRuntimeSignature(config);
  const renamed = {
    ...config,
    agent: {
      ...config.agent,
      connections: config.agent.connections.map((connection) => ({
        ...connection,
        label: `${connection.label} renamed`,
        models: connection.id === config.agent.active.connectionId ? [...connection.models, "another"] : connection.models,
      })),
    },
  };
  assert.equal(agentRuntimeSignature(renamed), signature);
  assert.notEqual(agentRuntimeSignature(withCredentialRevision(config, config.agent.active.connectionId)), signature);
});

test("credential revisions change only for the active connection and wrap safely", () => {
  const config = fixture();
  assert.equal(withCredentialRevision(config, "local"), config);
  assert.equal(withCredentialRevision(config, config.agent.active.connectionId).agent.credentialRevision, 1);
  const atMax = { ...config, agent: { ...config.agent, credentialRevision: MAX_CREDENTIAL_REVISION } };
  assert.equal(withCredentialRevision(atMax, atMax.agent.active.connectionId).agent.credentialRevision, 0);
  assert.throws(() => withCredentialRevision(config, "missing"), /not configured/);
});
