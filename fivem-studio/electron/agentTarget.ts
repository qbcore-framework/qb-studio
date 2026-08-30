export interface AgentTargetLike {
  connectionId: string;
  model: string;
}

export interface AgentConnectionLike {
  id: string;
  label: string;
  models: readonly string[];
}

export interface AgentRuntimeConnectionLike extends AgentConnectionLike {
  provider: string;
  baseUrl: string;
  requiresKey: boolean;
}

export interface AgentSettingsLike {
  connections: readonly AgentRuntimeConnectionLike[];
  active: AgentTargetLike;
}

export type AgentCredentialStageLike =
  | { kind: "replace"; value: string }
  | { kind: "clear"; reason?: string };

export type AgentTargetSwitchDecision = "no-op" | "blocked-busy" | "confirm" | "switch";

export function canStartAgentSend({
  message,
  ready,
  busy,
  switchingTarget,
  sendLocked,
}: {
  message: string;
  ready: boolean | null;
  busy: boolean;
  switchingTarget: boolean;
  sendLocked: boolean;
}): boolean {
  return Boolean(message.trim()) && ready === true && !busy && !switchingTarget && !sendLocked;
}

function comparableEndpoint(value: string): string {
  try { return new URL(value).toString(); } catch { return value.trim(); }
}

/** Explain exactly which Settings changes cross the native conversation
 * identity. Inactive credentials do not reset the currently selected chat. */
export function agentChatResetReasons(
  saved: AgentSettingsLike,
  next: AgentSettingsLike,
  keyStages: Readonly<Record<string, AgentCredentialStageLike | undefined>>,
): string[] {
  const reasons: string[] = [];
  if (saved.active.connectionId !== next.active.connectionId || saved.active.model !== next.active.model) {
    reasons.push("the active connection or model changed");
  }
  const savedActive = saved.connections.find((connection) => connection.id === saved.active.connectionId);
  const nextActive = next.connections.find((connection) => connection.id === next.active.connectionId);
  if (
    savedActive && nextActive && savedActive.id === nextActive.id &&
    (
      savedActive.provider !== nextActive.provider ||
      comparableEndpoint(savedActive.baseUrl) !== comparableEndpoint(nextActive.baseUrl) ||
      savedActive.requiresKey !== nextActive.requiresKey
    )
  ) {
    reasons.push("the active provider, endpoint, or credential policy changed");
  }
  const activeKeyStage = keyStages[next.active.connectionId];
  if (activeKeyStage?.kind === "clear" || (activeKeyStage?.kind === "replace" && activeKeyStage.value.trim())) {
    reasons.push("the active connection’s saved API key changed");
  }
  return reasons;
}

/** A collision-safe value for the native chat target select. */
export function agentTargetKey(target: AgentTargetLike): string {
  return JSON.stringify([target.connectionId, target.model]);
}

/** Resolve an untrusted select value only to a target present in normalized config. */
export function parseAgentTargetKey(
  value: string,
  connections: readonly AgentConnectionLike[],
): AgentTargetLike | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [connectionId, model] = parsed;
    if (typeof connectionId !== "string" || typeof model !== "string") return null;
    const connection = connections.find((candidate) => candidate.id === connectionId);
    return connection?.models.includes(model) ? { connectionId, model } : null;
  } catch {
    return null;
  }
}

export function sameAgentTarget(left: AgentTargetLike, right: AgentTargetLike): boolean {
  return left.connectionId === right.connectionId && left.model === right.model;
}

export function agentTargetLabel(target: AgentTargetLike, connections: readonly AgentConnectionLike[]): string {
  const connection = connections.find((candidate) => candidate.id === target.connectionId);
  return connection ? `${connection.label} · ${target.model}` : target.model;
}

/** Switching never replays native provider history across a model boundary. */
export function decideAgentTargetSwitch({
  current,
  next,
  busy,
  hasTranscript,
}: {
  current: AgentTargetLike;
  next: AgentTargetLike;
  busy: boolean;
  hasTranscript: boolean;
}): AgentTargetSwitchDecision {
  if (sameAgentTarget(current, next)) return "no-op";
  if (busy) return "blocked-busy";
  return hasTranscript ? "confirm" : "switch";
}
