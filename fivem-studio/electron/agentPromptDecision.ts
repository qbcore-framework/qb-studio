export type AgentPromptMode = "draft" | "submit";

export interface AgentPromptEnvelope {
  id: number;
  text: string;
  mode: AgentPromptMode;
  workspaceScope: string;
}

export type AgentAutoSubmitDecision = "send" | "pending" | "busy" | "unconfigured" | "empty";
export type AgentPromptDispatchDecision = AgentAutoSubmitDecision | "workspace-mismatch";

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

export function isAgentPromptForWorkspace(prompt: AgentPromptEnvelope, workspaceScope: string): boolean {
  return prompt.workspaceScope === workspaceScope;
}

export function decideAgentPromptDispatch({
  prompt,
  workspaceScope,
  ready,
  busy,
  sendLocked,
}: {
  prompt: AgentPromptEnvelope;
  workspaceScope: string;
  ready: boolean | null;
  busy: boolean;
  sendLocked: boolean;
}): AgentPromptDispatchDecision {
  if (!isAgentPromptForWorkspace(prompt, workspaceScope)) return "workspace-mismatch";
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
