export type AgentPromptMode = "draft" | "submit";

export interface AgentPromptEnvelope {
  id: number;
  text: string;
  mode: AgentPromptMode;
  workspaceScope: string;
  /** Prevents an automatic prompt from crossing into a different provider/model. */
  agentScope: string;
}

export type AgentAutoSubmitDecision = "send" | "pending" | "busy" | "unconfigured" | "empty";
export type AgentPromptDispatchDecision = AgentAutoSubmitDecision | "workspace-mismatch" | "agent-mismatch";

export function isUnconsumedAgentPrompt(lastConsumedId: number, nextId: number): boolean {
  return Number.isSafeInteger(nextId) && nextId > lastConsumedId;
}

export function consumeAgentPromptEnvelope(
  current: AgentPromptEnvelope | null,
  consumedId: number,
): AgentPromptEnvelope | null {
  return current?.id === consumedId ? null : current;
}

export function agentPromptWorkspaceScope(txDataPath: string | null, selectedProfile: string | null): string {
  return JSON.stringify([txDataPath ?? "", selectedProfile ?? ""]);
}

export function agentPromptAgentScope(
  connectionId: string,
  model: string,
  provider = "",
  baseUrl = "",
  credentialRevision = 0,
  requiresKey: boolean | null = null,
): string {
  return JSON.stringify([connectionId, model, provider, baseUrl, credentialRevision, requiresKey]);
}

export function isAgentPromptForWorkspace(prompt: AgentPromptEnvelope, workspaceScope: string): boolean {
  return prompt.workspaceScope === workspaceScope;
}

export function isAgentPromptForAgent(prompt: AgentPromptEnvelope, agentScope: string): boolean {
  return prompt.agentScope === agentScope;
}

export function decideAgentPromptDispatch({
  prompt,
  workspaceScope,
  agentScope,
  ready,
  busy,
  sendLocked,
}: {
  prompt: AgentPromptEnvelope;
  workspaceScope: string;
  agentScope: string;
  ready: boolean | null;
  busy: boolean;
  sendLocked: boolean;
}): AgentPromptDispatchDecision {
  if (!isAgentPromptForWorkspace(prompt, workspaceScope)) return "workspace-mismatch";
  if (!isAgentPromptForAgent(prompt, agentScope)) return "agent-mismatch";
  return decideAgentAutoSubmit({ text: prompt.text, ready, busy, sendLocked });
}

export function decideAgentAutoSubmit({
  text,
  ready,
  busy,
  sendLocked,
}: {
  text: string;
  ready: boolean | null;
  busy: boolean;
  sendLocked: boolean;
}): AgentAutoSubmitDecision {
  if (!text.trim()) return "empty";
  if (ready === null) return "pending";
  if (busy || sendLocked) return "busy";
  if (!ready) return "unconfigured";
  return "send";
}
