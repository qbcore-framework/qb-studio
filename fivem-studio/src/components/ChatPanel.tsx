import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { languageForPath } from "../editorLanguage";
import type { AgentEvent, AgentFilePreview, AgentTarget, ResolvedTheme, RuntimeWorkspaceMatch, StudioConfig, TurnUsage } from "../global";
import { matchPreset } from "../providerPresets";
import { t } from "../i18n";
import {
  agentPromptAgentScope,
  agentPromptWorkspaceScope,
  decideAgentPromptDispatch,
  isAgentPromptForAgent,
  isAgentPromptForWorkspace,
  isUnconsumedAgentPrompt,
  type AgentPromptEnvelope,
} from "../../electron/agentPromptDecision";
import {
  agentTargetKey,
  agentTargetLabel,
  canStartAgentSend,
  decideAgentTargetSwitch,
  parseAgentTargetKey,
} from "../../electron/agentTarget";
import {
  acceptAgentEvent,
  agentEventCursor,
  agentEventRuntimeScope,
  switchAgentEventCursor,
  type AgentEventCursor,
} from "../../electron/agentEventScope";

const ChangeDiff = lazy(() => import("./ChangeDiff"));

/**
 * A transcript entry. Tool calls get their own entries rather than being folded
 * into the assistant's text, so it's always visible what the agent actually ran
 * against the live server versus what it merely said.
 */
type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      approvalId?: string;
      approvalRisk?: "write" | "dangerous";
      approvalSummary?: string;
      approvalStatus?: "pending" | "responding" | "approved" | "denied";
      approvalReason?: string;
      approvalPreview?: AgentFilePreview;
      approvalPreviewError?: string;
    }
  | { kind: "error"; text: string };

/** Conversation-wide totals, built up from the per-response usage events. */
interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  contextTokens: number;
  contextWindow?: number;
  /** API requests so far — a tool-heavy turn makes many. */
  requests: number;
}

const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  contextTokens: 0,
  requests: 0,
};

function accumulate(prev: SessionUsage | null, turn: TurnUsage): SessionUsage {
  const base = prev ?? EMPTY_USAGE;
  return {
    inputTokens: base.inputTokens + turn.inputTokens,
    outputTokens: base.outputTokens + turn.outputTokens,
    cacheReadTokens: base.cacheReadTokens + turn.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + turn.cacheWriteTokens,
    costUsd: base.costUsd + (turn.costUsd ?? 0),
    // Context is how big the last request was, not a running sum — the
    // conversation is resent whole every time, so summing would multiply it.
    contextTokens: turn.contextTokens,
    contextWindow: turn.contextWindow ?? base.contextWindow,
    requests: base.requests + 1,
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Sub-cent totals round to $0.00, which reads as free rather than as small. */
function formatCost(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object" || Object.keys(input).length === 0) return "";
  const text = JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

interface ChatPanelProps {
  connected: boolean;
  config: StudioConfig;
  resolvedTheme: ResolvedTheme;
  workspaceMatch: RuntimeWorkspaceMatch | null;
  /** Live editor selection, if any — shown as a chip so it's never a surprise what gets sent. */
  selection: { path: string | null; selectedText: string; startLine: number; endLine: number } | null;
  suggestedPrompt: AgentPromptEnvelope | null;
  onSuggestedPromptConsumed: (id: number) => void;
  activePath: string | null;
  activeResourceName: string | null;
  onActivityChange: (active: boolean) => void;
  onSelectAgentTarget: (target: AgentTarget) => Promise<void>;
  onOpenAgentSettings: () => void;
}

export default function ChatPanel({
  connected,
  config,
  resolvedTheme,
  workspaceMatch,
  selection,
  suggestedPrompt,
  onSuggestedPromptConsumed,
  activePath,
  activeResourceName,
  onActivityChange,
  onSelectAgentTarget,
  onOpenAgentSettings,
}: ChatPanelProps) {
  const activeTarget = config.agent.active;
  const activeConnection = config.agent.connections.find((connection) => connection.id === activeTarget.connectionId)
    ?? config.agent.connections[0];
  const isAnthropic = activeConnection?.provider === "anthropic";
  const preset = matchPreset(activeConnection?.provider ?? "openai", activeConnection?.baseUrl ?? "");
  const agentScope = agentPromptAgentScope(
    activeTarget.connectionId,
    activeTarget.model,
    activeConnection?.provider,
    activeConnection?.baseUrl,
    config.agent.credentialRevision,
    activeConnection?.requiresKey ?? null,
  );
  const readinessScope = JSON.stringify([
    activeConnection?.id ?? "",
    activeConnection?.provider ?? "",
    activeConnection?.baseUrl ?? "",
    activeTarget.model,
    activeConnection?.requiresKey ?? true,
    config.agent.credentialRevision,
  ]);
  const runtimeScope = JSON.stringify([
    activeConnection?.id ?? "",
    activeConnection?.provider ?? "",
    activeConnection?.baseUrl ?? "",
    activeTarget.model,
    activeConnection?.requiresKey ?? true,
    config.agent.credentialRevision,
  ]);
  const workspaceScope = agentPromptWorkspaceScope(config.txDataPath, config.selectedProfile);
  const eventRuntimeScope = agentEventRuntimeScope(workspaceScope, agentScope);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [readiness, setReadiness] = useState<{ scope: string; value: boolean | null }>({
    scope: readinessScope,
    value: null,
  });
  const ready = readiness.scope === readinessScope ? readiness.value : null;
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [spendWarningDismissed, setSpendWarningDismissed] = useState(false);
  const [promptNotice, setPromptNotice] = useState<{ message: string; urgent: boolean } | null>(null);
  const [turnCompletion, setTurnCompletion] = useState(0);
  const [switchingTarget, setSwitchingTarget] = useState(false);
  const [resettingChat, setResettingChat] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendLockRef = useRef(false);
  const activeSendIdRef = useRef(0);
  const sendSequenceRef = useRef(0);
  const busyRef = useRef(busy);
  const readyRef = useRef(ready);
  const switchingTargetRef = useRef(switchingTarget);
  const resettingChatRef = useRef(resettingChat);
  const pendingTargetKeyRef = useRef<string | null>(null);
  const consumedPromptIdRef = useRef(0);
  const previousRuntimeScopeRef = useRef(runtimeScope);
  const eventRuntimeScopeRef = useRef(eventRuntimeScope);
  const eventCursorRef = useRef<AgentEventCursor>(agentEventCursor(eventRuntimeScope));

  // Ref updates happen during render so an event queued behind a config change
  // cannot slip through before the transcript-clearing effect runs.
  if (eventCursorRef.current.runtimeScope !== eventRuntimeScope) {
    eventCursorRef.current = switchAgentEventCursor(eventCursorRef.current, eventRuntimeScope);
  }

  busyRef.current = busy;
  readyRef.current = ready;
  switchingTargetRef.current = switchingTarget;
  resettingChatRef.current = resettingChat;
  eventRuntimeScopeRef.current = eventRuntimeScope;

  useEffect(() => {
    const pending = pendingTargetKeyRef.current;
    if (!pending || pending !== agentTargetKey(activeTarget)) return;
    pendingTargetKeyRef.current = null;
    switchingTargetRef.current = false;
    setSwitchingTarget(false);
  }, [activeTarget.connectionId, activeTarget.model]);

  const backendLabel = agentTargetLabel(activeTarget, config.agent.connections);

  // A keyless backend needs no credential, while every keyed connection has
  // its own write-only secret even when two accounts share an endpoint.
  useEffect(() => {
    let cancelled = false;
    const applyReady = (value: boolean) => {
      if (!cancelled) setReadiness({ scope: readinessScope, value });
    };
    const configured = Boolean(
      activeConnection
      && activeTarget.model
      && activeConnection.models.includes(activeTarget.model)
      && (activeConnection.provider === "anthropic" || activeConnection.baseUrl),
    );
    if (!configured || !activeConnection?.requiresKey) {
      setReadiness({ scope: readinessScope, value: configured });
      return () => { cancelled = true; };
    }
    setReadiness({ scope: readinessScope, value: null });
    void window.api.agent.hasConnectionKey(activeConnection.id)
      .then((has) => applyReady(configured && has))
      .catch(() => applyReady(false));
    return () => { cancelled = true; };
  }, [readinessScope, activeConnection, activeTarget.model]);

  useEffect(() => {
    return window.api.agent.onEvent((value: unknown) => {
      const accepted = acceptAgentEvent(value, eventCursorRef.current);
      if (!accepted) return;
      eventCursorRef.current = accepted.cursor;
      const event = accepted.event;
      if (!event) return;
      // Usage is a running tally rather than a transcript entry, so it's kept
      // out of the entries list entirely.
      if (event.type === "usage") {
        setUsage((prev) => accumulate(prev, event.usage));
        return;
      }
      if (event.type === "done") setTurnCompletion((current) => current + 1);
      const view = scrollRef.current;
      followOutputRef.current = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 48;
      setEntries((prev) => applyEvent(prev, event));
    });
  }, []);

  // Main starts a fresh native provider session for every runtime identity.
  // Mirror that boundary in the visible transcript while preserving anything
  // the user has typed but not sent.
  useEffect(() => {
    if (previousRuntimeScopeRef.current === runtimeScope) return;
    previousRuntimeScopeRef.current = runtimeScope;
    setEntries([]);
    setUsage(null);
    setTurnCompletion(0);
    setSpendWarningDismissed(false);
    setPromptNotice({ message: `Now using ${backendLabel}. A new chat was started.`, urgent: false });
  }, [runtimeScope, backendLabel]);

  // Follow streaming output only while the reader is already near the end.
  // Content growth does not itself fire scroll, so this remains true across
  // deltas until the user deliberately scrolls upward.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followOutputRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  useEffect(() => {
    if (!suggestedPrompt) return;
    if (!isUnconsumedAgentPrompt(consumedPromptIdRef.current, suggestedPrompt.id)) return;
    if (suggestedPrompt.mode === "draft") {
      if (!isAgentPromptForWorkspace(suggestedPrompt, workspaceScope)) {
        consumedPromptIdRef.current = suggestedPrompt.id;
        onSuggestedPromptConsumed(suggestedPrompt.id);
        setPromptNotice(null);
        return;
      }
      consumedPromptIdRef.current = suggestedPrompt.id;
      onSuggestedPromptConsumed(suggestedPrompt.id);
      setDraft(suggestedPrompt.text);
      if (!isAgentPromptForAgent(suggestedPrompt, agentScope)) {
        setPromptNotice({ message: "The agent changed, so the prepared request was kept as a draft instead of being sent.", urgent: false });
      }
      inputRef.current?.focus();
      return;
    }

    // A prepared automatic request remains unconsumed while native chat state
    // is changing. Once the transition lands this effect runs again: a target
    // mismatch is safely retained as a draft instead of being lost to a send
    // guard that correctly refuses the in-flight transition.
    if (switchingTargetRef.current || resettingChatRef.current) {
      setPromptNotice({ message: t("agent.autoSubmit.checking"), urgent: false });
      return;
    }

    const decision = decideAgentPromptDispatch({
      prompt: suggestedPrompt,
      workspaceScope,
      agentScope,
      ready: readyRef.current,
      busy: busyRef.current,
      sendLocked: sendLockRef.current,
    });
    if (decision === "pending") {
      setPromptNotice({ message: t("agent.autoSubmit.checking"), urgent: false });
      return;
    }
    if (decision === "workspace-mismatch") {
      consumedPromptIdRef.current = suggestedPrompt.id;
      onSuggestedPromptConsumed(suggestedPrompt.id);
      setPromptNotice(null);
      return;
    }
    if (decision === "agent-mismatch") {
      consumedPromptIdRef.current = suggestedPrompt.id;
      onSuggestedPromptConsumed(suggestedPrompt.id);
      setDraft(suggestedPrompt.text);
      setPromptNotice({
        message: "The agent changed, so the prepared request was kept as a draft instead of being sent.",
        urgent: false,
      });
      inputRef.current?.focus();
      return;
    }

    if (decision === "busy") {
      consumedPromptIdRef.current = suggestedPrompt.id;
      onSuggestedPromptConsumed(suggestedPrompt.id);
      setPromptNotice({ message: t("agent.autoSubmit.busy"), urgent: true });
      return;
    }
    if (decision === "unconfigured") {
      consumedPromptIdRef.current = suggestedPrompt.id;
      onSuggestedPromptConsumed(suggestedPrompt.id);
      setPromptNotice({ message: t("agent.autoSubmit.unconfigured"), urgent: true });
      return;
    }
    if (decision === "empty") {
      consumedPromptIdRef.current = suggestedPrompt.id;
      onSuggestedPromptConsumed(suggestedPrompt.id);
      setPromptNotice({ message: t("agent.autoSubmit.empty"), urgent: true });
      return;
    }

    setPromptNotice(null);
    const accepted = startSend(suggestedPrompt.text, false);
    consumedPromptIdRef.current = suggestedPrompt.id;
    onSuggestedPromptConsumed(suggestedPrompt.id);
    if (!accepted) setPromptNotice({ message: t("agent.autoSubmit.busy"), urgent: true });
  }, [suggestedPrompt, onSuggestedPromptConsumed, ready, workspaceScope, agentScope, switchingTarget, resettingChat]);

  useEffect(() => setSpendWarningDismissed(false), [config.agentSpendWarningUsd]);

  useEffect(() => () => onActivityChange(false), [onActivityChange]);

  function applyEvent(prev: Entry[], event: AgentEvent): Entry[] {
    switch (event.type) {
      case "text":
      case "thinking": {
        const kind = event.type === "text" ? "assistant" : "thinking";
        const last = prev[prev.length - 1];
        // Append to the in-progress block rather than making an entry per delta.
        if (last?.kind === kind) {
          return [...prev.slice(0, -1), { ...last, text: last.text + event.text }];
        }
        return [...prev, { kind, text: event.text } as Entry];
      }
      case "tool_use":
        return [...prev, { kind: "tool", id: event.id, name: event.name, input: event.input }];
      case "tool_result":
        return prev.map((e) =>
          e.kind === "tool" && e.id === event.id ? { ...e, result: event.content, isError: event.isError } : e,
        );
      case "approval_request":
        return prev.map((entry) =>
          entry.kind === "tool" && entry.id === event.toolCallId
            ? {
                ...entry,
                approvalId: event.approvalId,
                approvalRisk: event.risk,
                approvalSummary: event.summary,
                approvalStatus: "pending",
                approvalPreview: event.filePreview,
                approvalPreviewError: event.previewError,
              }
            : entry,
        );
      case "approval_resolved":
        return prev.map((entry) =>
          entry.kind === "tool" && entry.approvalId === event.approvalId
            ? {
                ...entry,
                approvalStatus: event.approved ? "approved" : "denied",
                approvalReason: event.reason,
              }
            : entry,
        );
      case "error":
        return [...prev, { kind: "error", text: event.message }];
      default:
        return prev;
    }
  }

  async function respondToApproval(approvalId: string, approved: boolean) {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.kind === "tool" && entry.approvalId === approvalId ? { ...entry, approvalStatus: "responding" } : entry,
      ),
    );
    try {
      await window.api.agent.respondToApproval(approvalId, approved);
    } catch (err) {
      setEntries((prev) => [
        ...prev.map((entry) =>
          entry.kind === "tool" && entry.approvalId === approvalId ? { ...entry, approvalStatus: "pending" as const } : entry,
        ),
        { kind: "error", text: (err as Error).message || "Could not answer the approval request." },
      ]);
    }
  }

  function startSend(message: string, clearDraft: boolean): boolean {
    const text = message.trim();
    if (!canStartAgentSend({
      message,
      ready: readyRef.current,
      busy: busyRef.current,
      switchingTarget: switchingTargetRef.current || resettingChatRef.current,
      sendLocked: sendLockRef.current,
    })) return false;
    const sendId = ++sendSequenceRef.current;
    activeSendIdRef.current = sendId;
    sendLockRef.current = true;
    busyRef.current = true;
    setPromptNotice(null);
    setEntries((prev) => [...prev, { kind: "user", text }]);
    if (clearDraft) setDraft("");
    setBusy(true);
    void Promise.resolve()
      .then(() => window.api.agent.send(text, eventRuntimeScope))
      .catch((err) => {
        if (clearDraft) setDraft((current) => current === "" ? message : current);
        setEntries((prev) => [...prev, { kind: "error", text: (err as Error).message || "Could not send the message." }]);
      })
      .finally(() => {
        if (activeSendIdRef.current !== sendId) return;
        activeSendIdRef.current = 0;
        sendLockRef.current = false;
        busyRef.current = false;
        setBusy(false);
      });
    return true;
  }

  function send() {
    startSend(draft, true);
  }

  async function newChat() {
    if (busyRef.current || switchingTargetRef.current || resettingChatRef.current) return;
    const requestedRuntimeScope = eventRuntimeScopeRef.current;
    resettingChatRef.current = true;
    setResettingChat(true);
    setPromptNotice(null);
    try {
      const generation: unknown = await window.api.agent.reset();
      if (eventRuntimeScopeRef.current !== requestedRuntimeScope) {
        setPromptNotice({
          message: "The workspace or agent changed while the new chat was starting, so its stale reset result was ignored.",
          urgent: false,
        });
        return;
      }
      eventCursorRef.current = agentEventCursor(requestedRuntimeScope, generation);
      setEntries([]);
      setUsage(null);
      setTurnCompletion(0);
      setSpendWarningDismissed(false);
    } catch (err) {
      setEntries((prev) => [...prev, { kind: "error", text: (err as Error).message || "Could not start a new chat." }]);
    } finally {
      resettingChatRef.current = false;
      setResettingChat(false);
    }
  }

  async function changeAgentTarget(value: string) {
    if (switchingTargetRef.current || resettingChatRef.current) return;
    const next = parseAgentTargetKey(value, config.agent.connections);
    if (!next) {
      setEntries((prev) => [...prev, { kind: "error", text: "That agent or model is no longer configured." }]);
      return;
    }
    const decision = decideAgentTargetSwitch({
      current: activeTarget,
      next,
      busy: busyRef.current,
      hasTranscript: entries.length > 0 || usage !== null,
    });
    if (decision === "no-op") return;
    if (decision === "blocked-busy") {
      setPromptNotice({ message: "Stop the current response before switching agents.", urgent: true });
      return;
    }
    if (decision === "confirm") {
      const from = agentTargetLabel(activeTarget, config.agent.connections);
      const to = agentTargetLabel(next, config.agent.connections);
      if (!confirm(
        `Switch from ${from} to ${to}?\n\n` +
        "Switching starts a new chat and clears this transcript and usage. Your unsent draft will be kept.",
      )) return;
    }

    switchingTargetRef.current = true;
    pendingTargetKeyRef.current = agentTargetKey(next);
    setSwitchingTarget(true);
    setPromptNotice(null);
    try {
      await onSelectAgentTarget(next);
    } catch (err) {
      pendingTargetKeyRef.current = null;
      switchingTargetRef.current = false;
      setSwitchingTarget(false);
      setPromptNotice({ message: (err as Error).message || "Could not switch agents.", urgent: true });
    }
  }

  return (
    <div
      className="pane chat-pane"
      style={{ height: "100%" }}
      onFocusCapture={() => onActivityChange(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) onActivityChange(false);
      }}
    >
      <div className="pane-header agent-chat-header">
        <h2 className="agent-chat-title">Agent Chat</h2>
        <div className="agent-chat-header-spacer" />
        <label className="sr-only" htmlFor="agent-target-select">Agent and model</label>
        <select
          id="agent-target-select"
          className="agent-target-select"
          value={agentTargetKey(activeTarget)}
          onChange={(event) => {
            const next = event.currentTarget.value;
            // Keep the controlled picker visibly on the current target while a
            // confirmation or main-process switch is pending (and after cancel).
            event.currentTarget.value = agentTargetKey(activeTarget);
            void changeAgentTarget(next);
          }}
          disabled={busy || switchingTarget || resettingChat}
          aria-describedby="agent-target-switch-help"
          title={backendLabel}
        >
          {config.agent.connections.map((connection) => (
            <optgroup key={connection.id} label={connection.label}>
              {connection.models.map((model) => (
                <option key={model} value={agentTargetKey({ connectionId: connection.id, model })}>
                  {connection.label} — {model}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span id="agent-target-switch-help" className="sr-only">
          Switching agents starts a new chat. The unsent draft is preserved.
        </span>
        <button
          type="button"
          className="btn small agent-settings-shortcut"
          onClick={onOpenAgentSettings}
          disabled={switchingTarget || resettingChat}
          aria-label="Manage agent connections"
          title="Manage agent connections"
        >
          ⚙
        </button>
        <button
          type="button"
          className="btn small"
          onClick={newChat}
          disabled={busy || switchingTarget || resettingChat || (entries.length === 0 && usage === null)}
          title={resettingChat
            ? "Starting a new chat"
            : entries.length === 0 && usage === null
              ? "This is already a new chat"
              : "Start a new chat"}
        >
          New chat
        </button>
      </div>

      {/* Held back until a turn finishes, so a streaming first reply doesn't
          flash "didn't report" before its usage chunk arrives at the end. */}
      {(usage || (entries.length > 0 && !busy)) && <UsageBar usage={usage} />}
      {usage && config.agentSpendWarningUsd > 0 && usage.costUsd >= config.agentSpendWarningUsd && !spendWarningDismissed && (
        <div className="agent-spend-warning" role="status">
          <span>{t("agent.spendWarning.notice", {
            cost: formatCost(usage.costUsd),
            threshold: `$${config.agentSpendWarningUsd.toFixed(2)}`,
          })}</span>
          <button type="button" className="banner-dismiss" onClick={() => setSpendWarningDismissed(true)} aria-label={t("common.dismiss")}>×</button>
        </div>
      )}
      {promptNotice && (
        <div
          className="agent-prompt-notice"
          role={promptNotice.urgent ? "alert" : "status"}
          aria-live={promptNotice.urgent ? "assertive" : "polite"}
        >
          <span>{promptNotice.message}</span>
          <button type="button" className="banner-dismiss" onClick={() => setPromptNotice(null)} aria-label={t("common.dismiss")}>×</button>
        </div>
      )}

      <div
        className="chat-messages"
        ref={scrollRef}
        role="log"
        aria-label={t("agent.transcript.label")}
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
        onScroll={(event) => {
          const view = event.currentTarget;
          followOutputRef.current = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
        }}
      >
        {ready === false && (
          <div className="chat-message system">
            <div>
              {isAnthropic
                ? `No API key is saved for ${activeConnection?.label ?? "this Anthropic connection"} — add one in Settings or switch agents.`
                : `${activeConnection?.label ?? preset.label} isn't configured yet — finish setting it up in Settings or switch agents.`}
            </div>
            <button type="button" className="btn small agent-configure-action" onClick={onOpenAgentSettings}>
              Manage agent connections
            </button>
          </div>
        )}
        {ready && !connected && (
          <div className="chat-message system">
            The bundled coding runtime is unavailable. Project-file tools remain available.
          </div>
        )}
        {ready && connected && workspaceMatch && !workspaceMatch.ok && (
          <div className="chat-message system">
            Resource lifecycle changes are unavailable because the workspace and local runtime do not match. Project tools and console output still work.
          </div>
        )}
        {entries.length === 0 && ready && (
          <>
            <div className="chat-message system">
              Using <strong>{backendLabel}</strong>. Ask the agent to inspect code, check recent console output, or restart a
              resource after an approved change.
            </div>
            <div className="agent-starters" role="group" aria-label={t("agent.starters.label")}>
              <button
                type="button"
                className="agent-starter-chip"
                disabled={!connected}
                onClick={() => {
                  setDraft(`Read the recent console output and explain why my last restart${activeResourceName ? ` of ${activeResourceName}` : ""} failed. Identify the cause before proposing changes.`);
                  inputRef.current?.focus();
                }}
              >
                {t("agent.starter.restart")}
              </button>
              <button
                type="button"
                className="agent-starter-chip"
                disabled={!activePath}
                onClick={() => {
                  setDraft(`Explain the currently open file${activePath ? ` (${activePath.split(/[/\\]/).pop()})` : ""}, including how it fits into the resource and any risky assumptions.`);
                  inputRef.current?.focus();
                }}
              >
                {t("agent.starter.explain")}
              </button>
              <button
                type="button"
                className="agent-starter-chip"
                disabled={!activeResourceName}
                onClick={() => {
                  setDraft(`Add a command to ${activeResourceName ?? "the active resource"}. First inspect the resource's existing command patterns and ask me for the command behavior if it is ambiguous.`);
                  inputRef.current?.focus();
                }}
              >
                {t("agent.starter.command")}
              </button>
            </div>
          </>
        )}

        {entries.map((entry, i) => {
          if (entry.kind === "tool") {
            return (
              <div key={i} className={`tool-call ${entry.isError ? "error" : ""}`}>
                <div className="tool-call-head">
                  <span className="tool-call-name">{entry.name}</span>
                  <span className="tool-call-args">{summarizeInput(entry.input)}</span>
                  {entry.result === undefined && <span className="tool-call-status">running…</span>}
                </div>
                {entry.approvalId && (
                  <div className={`tool-approval ${entry.approvalRisk === "dangerous" ? "dangerous" : "write"}`}>
                    <div className="tool-approval-summary">
                      <strong>{entry.approvalRisk === "dangerous" ? "Dangerous action" : "Review change"}</strong>
                      <span>{entry.approvalSummary}</span>
                    </div>
                    {entry.approvalPreview ? (
                      <div className="approval-change-preview">
                        <div className="approval-change-path">{entry.approvalPreview.path}</div>
                        {entry.approvalPreview.warning && (
                          <div className="approval-preview-warning" role="alert">{entry.approvalPreview.warning}</div>
                        )}
                        <div className="approval-change-labels" aria-hidden="true">
                          <span>{entry.approvalPreview.originalLabel}</span>
                          <span>{entry.approvalPreview.modifiedLabel}</span>
                        </div>
                        <div className="approval-change-diff">
                          <Suspense fallback={<div className="approval-preview-loading">Loading proposed change…</div>}>
                            <ChangeDiff
                              id={entry.approvalId}
                              original={entry.approvalPreview.originalContent}
                              modified={entry.approvalPreview.modifiedContent}
                              language={languageForPath(entry.approvalPreview.path)}
                              fontSize={config.editor.fontSize}
                              wordWrap={config.editor.wordWrap}
                              resolvedTheme={resolvedTheme}
                              compact
                            />
                          </Suspense>
                        </div>
                      </div>
                    ) : (
                      <details>
                        <summary>{entry.approvalPreviewError ? "Preview unavailable — inspect arguments" : "Inspect arguments"}</summary>
                        {entry.approvalPreviewError && <div className="approval-preview-warning">{entry.approvalPreviewError}</div>}
                        <pre>{JSON.stringify(entry.input, null, 2)}</pre>
                      </details>
                    )}
                    {entry.approvalStatus === "pending" ? (
                      <div className="tool-approval-actions">
                        <button className="btn small primary" onClick={() => void respondToApproval(entry.approvalId!, true)}>
                          Approve once
                        </button>
                        <button className="btn small" onClick={() => void respondToApproval(entry.approvalId!, false)}>
                          Deny
                        </button>
                      </div>
                    ) : entry.approvalStatus === "responding" ? (
                      <div className="tool-approval-state">Recording decision…</div>
                    ) : (
                      <div className={`tool-approval-state ${entry.approvalStatus}`}>
                        {entry.approvalStatus === "approved" ? "Approved once" : entry.approvalReason ?? "Denied"}
                      </div>
                    )}
                  </div>
                )}
                {entry.result !== undefined && <pre className="tool-call-result">{entry.result}</pre>}
              </div>
            );
          }
          if (entry.kind === "error") {
            return (
              <div key={i} className="chat-message error" role="alert">
                {entry.text}
              </div>
            );
          }
          return (
            <div key={i} className={`chat-message ${entry.kind}`}>
              {entry.text}
            </div>
          );
        })}

        {busy && (
          <div className="chat-working" role="status" aria-live="polite">
            {entries.some((entry) => entry.kind === "tool" && entry.approvalStatus === "pending")
              ? "Waiting for your approval…"
              : "Working…"}
          </div>
        )}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {turnCompletion > 0 && <span key={turnCompletion}>{t("agent.turnFinished")}</span>}
      </div>

      {selection && (
        <div className="selection-chip">
          <span className="icon">✎</span>
          <span>
            {selection.path?.split(/[/\\]/).pop() ?? "selection"} · lines {selection.startLine}–{selection.endLine} will
            be included
          </span>
        </div>
      )}

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          rows={2}
          value={draft}
          placeholder={resettingChat
            ? "Starting a new chat…"
            : ready === null
            ? "Checking the selected agent…"
            : switchingTarget
              ? "Switching agents…"
            : ready === false
              ? "Configure this agent in Settings first…"
              : "Ask your agent to do something…"}
          disabled={ready !== true || switchingTarget || resettingChat}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button
            className="btn"
            onClick={() => {
              void window.api.agent.cancel().catch((err) => {
                setEntries((prev) => [...prev, { kind: "error", text: (err as Error).message || "Could not stop the agent." }]);
              });
            }}
          >
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={send} disabled={ready !== true || switchingTarget || resettingChat || !draft.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Token and cost readout for the conversation so far. The context meter only
 * appears when the backend actually reported a window size — an arbitrary
 * OpenAI-compatible endpoint doesn't, and a guessed denominator would be worse
 * than none.
 *
 * A null `usage` after a completed turn means the backend never sent token
 * counts at all. That says so explicitly rather than rendering nothing, so the
 * difference between "this server is silent" and "the feature is broken" is
 * visible instead of being something you have to go read the code to find out.
 */
function UsageBar({ usage }: { usage: SessionUsage | null }) {
  if (!usage) {
    return (
      <div className="usage-bar">
        <div className="usage-row">
          <span className="usage-muted">This model backend didn&rsquo;t report token usage.</span>
        </div>
      </div>
    );
  }

  const cacheTotal = usage.cacheReadTokens + usage.cacheWriteTokens;
  const pct = usage.contextWindow ? Math.min(100, (usage.contextTokens / usage.contextWindow) * 100) : null;
  const level = pct === null ? "" : pct >= 90 ? "critical" : pct >= 70 ? "warn" : "ok";

  return (
    <div className="usage-bar">
      <div className="usage-row">
        <span className="usage-stat" title="Prompt tokens billed at full rate (cache hits excluded)">
          <span className="usage-arrow">↑</span>
          {formatTokens(usage.inputTokens)}
        </span>
        <span className="usage-stat" title="Tokens the model generated, including reasoning">
          <span className="usage-arrow">↓</span>
          {formatTokens(usage.outputTokens)}
        </span>
        {cacheTotal > 0 && (
          <span
            className="usage-stat"
            title={`${usage.cacheReadTokens.toLocaleString()} read from cache, ${usage.cacheWriteTokens.toLocaleString()} written to it`}
          >
            <span className="usage-key">cache</span>
            {formatTokens(cacheTotal)}
          </span>
        )}
        <span className="usage-spacer" />
        <span className="usage-stat" title={`${usage.requests} API request${usage.requests === 1 ? "" : "s"} this conversation`}>
          <span className="usage-key">reqs</span>
          {usage.requests}
        </span>
        {usage.costUsd > 0 && (
          <span className="usage-cost" title="Estimated from list pricing for this conversation">
            {formatCost(usage.costUsd)}
          </span>
        )}
      </div>

      {pct === null ? (
        <div className="usage-context">
          <span>{usage.contextTokens.toLocaleString()} tokens in context</span>
        </div>
      ) : (
        <div
          className="usage-context"
          title={`${usage.contextTokens.toLocaleString()} of ${usage.contextWindow!.toLocaleString()} tokens used in the context window`}
        >
          <div className="usage-track">
            <div className={`usage-fill ${level}`} style={{ width: `${pct}%` }} />
          </div>
          <span>
            {formatTokens(usage.contextTokens)} / {formatTokens(usage.contextWindow!)} · {pct.toFixed(0)}%
          </span>
        </div>
      )}
    </div>
  );
}
