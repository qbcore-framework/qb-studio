// Orchestrates Studio's chat panel: owns the running/cancel state and picks
// which backend answers. The actual model loops live in providers/.
//
// Runs main-process-only — credentials never cross into the renderer, and the
// MCP client whose tools the agent drives already lives here.

import type { BrowserWindow } from "electron";

import {
  loadConfig,
  loadConnectionKey,
  type AgentConnection,
  type AgentTarget,
  type StudioConfig,
} from "./configStore";
import { mcpIsConnected } from "./mcpClient";
import { getEditorContext } from "./projectTools";
import { cancelPendingToolApprovals } from "./toolApproval";
import {
  agentEventRuntimeScope,
  nextAgentConversationGeneration,
  type AgentEventEnvelope,
} from "./agentEventScope";
import { agentPromptAgentScope, agentPromptWorkspaceScope } from "./agentPromptDecision";
import { AnthropicProvider, listAnthropicModels } from "./providers/anthropicProvider";
import { OpenAICompatibleProvider, listModels } from "./providers/openaiProvider";
import type { AgentEvent, ChatProvider } from "./providers/types";

export type { AgentEvent } from "./providers/types";

/**
 * Lists models for a configured connection. The endpoint and stored key are
 * always resolved main-side from its opaque id so a renderer cannot redirect a
 * saved credential to another host.
 */
export function listConnectionModels(connectionId: string) {
  const config = loadConfig();
  const connection = config.agent.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) throw new Error("That agent connection is not configured.");
  const apiKey = loadConnectionKey(connection.id);
  return connection.provider === "anthropic"
    ? listAnthropicModels(apiKey)
    : listModels(connection.baseUrl, apiKey);
}

/** Probe an unsaved or endpoint-edited Settings draft using only the key the
 * user just typed. This path deliberately never looks up a stored credential. */
export function probeModels(connection: Pick<AgentConnection, "provider" | "baseUrl">, keyOverride = "") {
  return connection.provider === "anthropic"
    ? listAnthropicModels(keyOverride)
    : listModels(connection.baseUrl, keyOverride);
}

let provider: ChatProvider | null = null;
let providerKey = "";
let running = false;
let conversationGeneration = 0;

/**
 * Providers are rebuilt when the relevant settings change — and since each owns
 * its own history, that also means switching provider or model starts a fresh
 * conversation rather than replaying one model's transcript into another.
 */
function activeConnection(config: StudioConfig): { connection: AgentConnection; target: AgentTarget } {
  const target = config.agent.active;
  const connection = config.agent.connections.find((candidate) => candidate.id === target.connectionId);
  if (!connection || !connection.models.includes(target.model)) {
    throw new Error("The selected agent connection or model is no longer configured.");
  }
  return { connection, target };
}

function getProvider(): ChatProvider {
  const config = loadConfig();
  const { connection, target } = activeConnection(config);
  const apiKey = loadConnectionKey(connection.id);
  // Credential revisions are main-owned and advance whenever the active
  // connection's key changes. They let us invalidate the provider without ever
  // hashing, comparing, or otherwise deriving cache identity from secret bytes.
  const key = agentPromptAgentScope(
    target.connectionId,
    target.model,
    connection.provider,
    connection.baseUrl,
    config.agent.credentialRevision,
    connection.requiresKey,
  );

  if (connection.provider === "openai") {
    if (!provider || providerKey !== key) {
      provider = new OpenAICompatibleProvider({
        baseUrl: connection.baseUrl,
        model: target.model,
        apiKey,
      });
      providerKey = key;
    }
    return provider;
  }

  if (!provider || providerKey !== key) {
    provider = new AnthropicProvider({ apiKey, model: target.model });
    providerKey = key;
  }
  return provider;
}

export function resetConversation(): number {
  // Advance first: abort/finally callbacks already queued by the old provider
  // must retain their old generation and cannot enter the new transcript.
  conversationGeneration = nextAgentConversationGeneration(conversationGeneration);
  cancelPendingToolApprovals("The conversation was reset.");
  if (running) provider?.cancel();
  provider?.reset();
  provider = null;
  providerKey = "";
  return conversationGeneration;
}

export function cancelTurn(): void {
  cancelPendingToolApprovals();
  provider?.cancel();
}

export function isRunning(): boolean {
  return running;
}

function eventRuntimeScope(config: StudioConfig): string {
  const { connection, target } = activeConnection(config);
  return agentEventRuntimeScope(
    agentPromptWorkspaceScope(config.txDataPath, config.selectedProfile),
    agentPromptAgentScope(
      target.connectionId,
      target.model,
      connection.provider,
      connection.baseUrl,
      config.agent.credentialRevision,
      connection.requiresKey,
    ),
  );
}

function emit(win: BrowserWindow, envelope: AgentEventEnvelope): void {
  if (!win.isDestroyed()) win.webContents.send("agent:event", envelope);
}

export async function sendMessage(
  win: BrowserWindow,
  userMessage: string,
  expectedRuntimeScope: string,
): Promise<void> {
  const turnGeneration = conversationGeneration;
  const runtimeScope = eventRuntimeScope(loadConfig());
  if (expectedRuntimeScope !== runtimeScope) {
    throw new Error("The selected agent changed before this message could be sent. Your draft was kept; review the target and send again.");
  }
  const emitTurn = (event: AgentEvent) => emit(win, {
    conversationGeneration: turnGeneration,
    runtimeScope,
    event,
  });
  // Establish the generation before checking the busy guard as well: after a
  // workspace reset, the old turn may still be unwinding while the new panel
  // needs a trustworthy boundary for its explanatory error.
  emit(win, { conversationGeneration: turnGeneration, runtimeScope, event: null });
  if (running) {
    emitTurn({ type: "error", message: "The agent is already working on a message." });
    return;
  }

  running = true;
  try {
    // Not a hard stop any more: without MCP the agent loses the server tools but
    // keeps the project file tools, so it can still read and edit code.
    if (!mcpIsConnected()) {
      emitTurn({
        type: "error",
        message:
          "The bundled coding runtime is unavailable — the agent can still read and edit project files, but cannot read logs or reload resources.",
      });
    }

    // A live selection is prepended as context so "look at my highlighted code"
    // works without the model having to know to go ask for it.
    const editor = getEditorContext();
    const prompt = editor.selectedText
      ? `[The user currently has this selected in ${editor.path ?? "the editor"}, lines ${editor.startLine}-${editor.endLine}:\n\n${editor.selectedText}\n]\n\n${userMessage}`
      : userMessage;

    await getProvider().runTurn(prompt, emitTurn);
  } finally {
    running = false;
    emitTurn({ type: "done" });
  }
}
