import {
  MAX_AGENT_CONNECTIONS,
  MAX_CREDENTIAL_REVISION,
  MAX_MODELS_PER_CONNECTION,
  type AgentConnection,
  type AgentSettings,
  type StudioConfig,
} from "./configStore";
import { agentPromptAgentScope } from "./agentPromptDecision";
import { isKnownKeyedOpenAIEndpoint } from "./agentProviderPolicy";
import { parseProviderUrl } from "./localUrl";

const CONNECTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface AgentConnectionProbe {
  provider: "anthropic" | "openai";
  baseUrl: string;
  requiresKey: boolean;
}

export interface AgentCredentialUpdate {
  connectionId: string;
  key: string;
}

export function requireAgentConnectionId(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_ID.test(value)) {
    throw new Error("Agent connection id is invalid.");
  }
  return value;
}

export function requireAgentModel(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 256 ||
      CONTROL_CHARACTER.test(value)) {
    throw new Error("Agent model is invalid.");
  }
  return value;
}

/** Credential text is write-only but still untrusted IPC input. Reject
 * ambiguous whitespace instead of silently turning it into another key or a
 * destructive clear operation. An explicit empty string remains the clear API. */
export function requireConnectionKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || value !== value.trim() || CONTROL_CHARACTER.test(value)) {
    throw new Error("API key must be at most 4096 characters without leading, trailing, or control whitespace.");
  }
  return value;
}

export function requireAgentCredentialUpdates(
  value: unknown,
  settings: AgentSettings,
): AgentCredentialUpdate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_AGENT_CONNECTIONS) {
    throw new Error(`Save no more than ${MAX_AGENT_CONNECTIONS} agent credential changes at once.`);
  }
  const configured = new Map(settings.connections.map((connection) => [connection.id, connection]));
  const seen = new Set<string>();
  return value.map((candidate) => {
    const update = recordValue(candidate);
    const connectionId = requireAgentConnectionId(update?.connectionId);
    const key = requireConnectionKey(update?.key);
    if (seen.has(connectionId)) throw new Error("Each agent connection can have only one credential change per save.");
    seen.add(connectionId);
    const connection = configured.get(connectionId);
    if (!connection) throw new Error("A credential change targets an agent connection that is not being saved.");
    if (!connection.requiresKey && key) {
      throw new Error(`Agent connection “${connection.label}” is keyless and cannot store or send an API key.`);
    }
    return { connectionId, key };
  });
}

/** Draft probes never use stored credentials. Only the validated endpoint and
 * renderer-supplied transient key are sent to the provider. */
export function requireAgentConnectionProbe(value: unknown): AgentConnectionProbe {
  const connection = recordValue(value);
  if (!connection || (connection.provider !== "openai" && connection.provider !== "anthropic")) {
    throw new Error("Model-provider draft is invalid.");
  }
  if (typeof connection.requiresKey !== "boolean") throw new Error("Model-provider credential policy is invalid.");
  if (connection.provider === "anthropic") {
    if (connection.baseUrl !== "") throw new Error("Anthropic connections cannot override the API endpoint.");
    if (!connection.requiresKey) throw new Error("Anthropic connections require an API key.");
    return { provider: "anthropic", baseUrl: "", requiresKey: true };
  }
  if (typeof connection.baseUrl !== "string" || connection.baseUrl.length > 2048) {
    throw new Error("Model-provider draft URL is invalid.");
  }
  const endpoint = parseProviderUrl(connection.baseUrl);
  if (isKnownKeyedOpenAIEndpoint(endpoint.toString()) && !connection.requiresKey) {
    throw new Error("Built-in hosted model-provider endpoints require an API key.");
  }
  return { provider: "openai", baseUrl: endpoint.toString(), requiresKey: connection.requiresKey };
}

/** Renderer config is untrusted. Reject malformed input instead of silently
 * normalizing it into a different active provider. */
export function requireAgentSettings(value: unknown): AgentSettings {
  const settings = recordValue(value);
  if (!settings || settings.schemaVersion !== 1 || !Array.isArray(settings.connections)) {
    throw new Error("Agent connections are invalid.");
  }
  if (settings.connections.length < 1 || settings.connections.length > MAX_AGENT_CONNECTIONS) {
    throw new Error(`Configure between 1 and ${MAX_AGENT_CONNECTIONS} agent connections.`);
  }

  const ids = new Set<string>();
  const labels = new Set<string>();
  const modelsByConnection = new Map<string, Set<string>>();
  for (const item of settings.connections) {
    const connection = recordValue(item);
    if (!connection || typeof connection.id !== "string" || !CONNECTION_ID.test(connection.id) || ids.has(connection.id)) {
      throw new Error("Every agent connection needs a unique valid id.");
    }
    ids.add(connection.id);
    if (typeof connection.label !== "string" || connection.label !== connection.label.trim() || !connection.label ||
        connection.label.length > 80 || CONTROL_CHARACTER.test(connection.label)) {
      throw new Error("Every agent connection needs a label of 1–80 characters.");
    }
    const foldedLabel = connection.label.toLocaleLowerCase();
    if (labels.has(foldedLabel)) throw new Error("Every agent connection needs a unique label.");
    labels.add(foldedLabel);
    if (connection.provider !== "openai" && connection.provider !== "anthropic") {
      throw new Error(`Agent connection “${connection.label}” has an unsupported provider.`);
    }
    if (typeof connection.requiresKey !== "boolean") {
      throw new Error(`Agent connection “${connection.label}” has an invalid credential setting.`);
    }
    if (connection.provider === "anthropic") {
      if (connection.baseUrl !== "") throw new Error("Anthropic connections cannot override the API endpoint.");
      if (connection.requiresKey !== true) throw new Error("Anthropic connections require an API key.");
    } else if (typeof connection.baseUrl !== "string" || connection.baseUrl.length > 2048) {
      throw new Error(`Agent connection “${connection.label}” has an invalid provider URL.`);
    } else {
      const endpoint = parseProviderUrl(connection.baseUrl);
      if (isKnownKeyedOpenAIEndpoint(endpoint.toString()) && connection.requiresKey !== true) {
        throw new Error("Built-in hosted model-provider endpoints require an API key.");
      }
    }
    if (!Array.isArray(connection.models) || connection.models.length < 1 || connection.models.length > MAX_MODELS_PER_CONNECTION) {
      throw new Error(`Agent connection “${connection.label}” needs between 1 and ${MAX_MODELS_PER_CONNECTION} models.`);
    }
    const models = new Set<string>();
    for (const model of connection.models) {
      if (typeof model !== "string" || model !== model.trim() || !model || model.length > 256 ||
          CONTROL_CHARACTER.test(model) || models.has(model)) {
        throw new Error(`Agent connection “${connection.label}” contains an invalid or duplicate model.`);
      }
      models.add(model);
    }
    modelsByConnection.set(connection.id, models);
  }

  const active = recordValue(settings.active);
  if (!active || typeof active.connectionId !== "string" || typeof active.model !== "string" ||
      !modelsByConnection.get(active.connectionId)?.has(active.model)) {
    throw new Error("The selected agent and model are not configured.");
  }
  if (typeof settings.credentialRevision !== "number" || !Number.isInteger(settings.credentialRevision) ||
      settings.credentialRevision < 0 || settings.credentialRevision > MAX_CREDENTIAL_REVISION) {
    throw new Error("The agent credential revision is invalid.");
  }
  return settings as unknown as AgentSettings;
}

/** Credential revision is main-owned. Settings drafts may be stale while a key
 * IPC updates it, so never accept that field back from the renderer. */
export function requireAgentSettingsUpdate(value: unknown, credentialRevision: number): AgentSettings {
  const settings = recordValue(value);
  if (!settings) throw new Error("Agent connections are invalid.");
  return requireAgentSettings({ ...settings, credentialRevision });
}

export function activeAgentConnection(config: StudioConfig): AgentConnection {
  const connection = config.agent.connections.find((candidate) => candidate.id === config.agent.active.connectionId);
  if (!connection || !connection.models.includes(config.agent.active.model)) {
    throw new Error("The selected agent connection or model is unavailable.");
  }
  return connection;
}

/** Label, inactive connections, and inactive model catalogs do not alter the
 * native provider session. Endpoint, account revision, or active model do. */
export function agentRuntimeSignature(config: StudioConfig): string {
  const connection = activeAgentConnection(config);
  return agentPromptAgentScope(
    connection.id,
    config.agent.active.model,
    connection.provider,
    connection.baseUrl,
    config.agent.credentialRevision,
    connection.requiresKey,
  );
}

export function withAgentTarget(config: StudioConfig, connectionIdValue: unknown, modelValue: unknown): StudioConfig {
  const connectionId = requireAgentConnectionId(connectionIdValue);
  const model = requireAgentModel(modelValue);
  const connection = config.agent.connections.find((candidate) => candidate.id === connectionId);
  if (!connection || !connection.models.includes(model)) {
    throw new Error("That agent or model is no longer configured.");
  }
  if (config.agent.active.connectionId === connectionId && config.agent.active.model === model) return config;
  return {
    ...config,
    agent: { ...config.agent, active: { connectionId, model } },
  };
}

/** Only a credential change for the active connection affects its session and
 * renderer readiness. Inactive keys are checked when that connection is chosen. */
export function withCredentialRevision(config: StudioConfig, connectionIdValue: unknown): StudioConfig {
  const connectionId = requireAgentConnectionId(connectionIdValue);
  if (!config.agent.connections.some((connection) => connection.id === connectionId)) {
    throw new Error("That agent connection is not configured.");
  }
  if (config.agent.active.connectionId !== connectionId) return config;
  const credentialRevision = config.agent.credentialRevision >= MAX_CREDENTIAL_REVISION
    ? 0
    : config.agent.credentialRevision + 1;
  return {
    ...config,
    agent: { ...config.agent, credentialRevision },
  };
}
