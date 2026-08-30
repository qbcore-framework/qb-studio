import type { AgentEvent } from "./providers/types";

export interface AgentEventEnvelope {
  /** Monotonic within this main-process lifetime; advanced before every reset. */
  conversationGeneration: number;
  /** Workspace plus provider/account/model identity captured when the turn began. */
  runtimeScope: string;
  /** Null is a main-owned generation handshake emitted before provider work. */
  event: AgentEvent | null;
}

export interface AgentEventCursor {
  runtimeScope: string;
  /** Null until a main-owned turn handshake establishes it. */
  conversationGeneration: number | null;
  /** A switch resets main state, so the next runtime must be newer than this. */
  minimumGenerationExclusive: number | null;
}

export interface AcceptedAgentEvent {
  event: AgentEvent | null;
  cursor: AgentEventCursor;
}

const MAX_GENERATION = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** One scope for both workspace-bound context and provider-native conversation state. */
export function agentEventRuntimeScope(workspaceScope: string, agentScope: string): string {
  return JSON.stringify([workspaceScope, agentScope]);
}

export function nextAgentConversationGeneration(current: number): number {
  return validGeneration(current) && current < MAX_GENERATION ? current + 1 : 0;
}

/** Reset/switch the renderer cursor before any queued events can be rendered. */
export function agentEventCursor(runtimeScope: string, generation: unknown = null): AgentEventCursor {
  return {
    runtimeScope,
    conversationGeneration: validGeneration(generation) ? generation : null,
    minimumGenerationExclusive: null,
  };
}

/** Carry the generation high-water mark across runtime switches. This also
 * protects a rapid A → B → A switch from adopting a very late event from the
 * first A conversation before the new A turn emits anything. */
export function switchAgentEventCursor(cursor: AgentEventCursor, runtimeScope: string): AgentEventCursor {
  if (cursor.runtimeScope === runtimeScope) return cursor;
  const known = cursor.conversationGeneration ?? cursor.minimumGenerationExclusive;
  return {
    runtimeScope,
    conversationGeneration: null,
    minimumGenerationExclusive: known,
  };
}

/**
 * Accept only events from the currently visible runtime and conversation.
 * A newly selected runtime learns its generation from a null turn handshake;
 * an explicit New chat receives the generation directly from resetConversation.
 */
export function acceptAgentEvent(value: unknown, cursor: AgentEventCursor): AcceptedAgentEvent | null {
  if (!isRecord(value) || value.runtimeScope !== cursor.runtimeScope ||
      !validGeneration(value.conversationGeneration) ||
      (value.event !== null && (!isRecord(value.event) || typeof value.event.type !== "string"))) {
    return null;
  }
  if (cursor.conversationGeneration !== null && value.conversationGeneration !== cursor.conversationGeneration) {
    return null;
  }
  // A remounted ChatPanel has no trustworthy generation high-water mark. Never
  // let a queued text/done event establish it; only sendMessage's handshake can.
  if (cursor.conversationGeneration === null && value.event !== null) return null;
  if (cursor.conversationGeneration === null && cursor.minimumGenerationExclusive !== null &&
      value.conversationGeneration <= cursor.minimumGenerationExclusive) {
    return null;
  }
  return {
    event: value.event as AgentEvent | null,
    cursor: {
      runtimeScope: cursor.runtimeScope,
      conversationGeneration: value.conversationGeneration,
      minimumGenerationExclusive: cursor.minimumGenerationExclusive,
    },
  };
}
