import { useEffect, useRef, useState } from "react";

import type { AgentConnection, AgentModelListResult, AgentSettings } from "../global";
import { COST_LABEL, PROVIDER_PRESETS, matchPreset } from "../providerPresets";
import { isKnownKeyedOpenAIEndpoint } from "../../electron/agentProviderPolicy";

export type ConnectionKeyStage =
  | { kind: "replace"; value: string }
  | { kind: "clear"; reason: "explicit" | "scope-change" };

export type ConnectionKeyStages = Record<string, ConnectionKeyStage | undefined>;

interface AgentConnectionsEditorProps {
  value: AgentSettings;
  savedValue: AgentSettings;
  keyStages: ConnectionKeyStages;
  disabled?: boolean;
  onChange: (value: AgentSettings) => void;
  onKeyStagesChange: (value: ConnectionKeyStages) => void;
  onBusyChange: (busy: boolean) => void;
}

const MAX_CONNECTIONS = 32;
const MAX_MODELS = 64;
const DEFAULT_GEMINI = PROVIDER_PRESETS.find((preset) => preset.id === "gemini") ?? PROVIDER_PRESETS[0];
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const CONNECTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/;

function cloneAgentSettings(value: AgentSettings): AgentSettings {
  return {
    schemaVersion: 1,
    connections: value.connections.map((connection) => ({ ...connection, models: [...connection.models] })),
    active: { ...value.active },
    credentialRevision: Number.isSafeInteger(value.credentialRevision) && value.credentialRevision >= 0
      ? value.credentialRevision
      : 0,
  };
}

export function defaultAgentSettings(): AgentSettings {
  const connection: AgentConnection = {
    id: "google-gemini-default",
    label: DEFAULT_GEMINI.label,
    provider: "openai",
    baseUrl: DEFAULT_GEMINI.baseUrl,
    models: [DEFAULT_GEMINI.model].filter(Boolean),
    requiresKey: DEFAULT_GEMINI.needsKey,
  };
  return {
    schemaVersion: 1,
    connections: [connection],
    active: { connectionId: connection.id, model: connection.models[0] ?? "gemini-3.7-flash" },
    credentialRevision: 0,
  };
}

export function agentSettingsFromConfig(config: unknown): AgentSettings {
  const candidate = (config as { agent?: AgentSettings } | null)?.agent;
  if (!candidate || candidate.schemaVersion !== 1 || !Array.isArray(candidate.connections)) return defaultAgentSettings();
  return cloneAgentSettings(candidate);
}

export function validateAgentSettings(value: AgentSettings): string[] {
  const errors: string[] = [];
  if (value.connections.length === 0) errors.push("Keep at least one saved agent connection.");
  if (value.connections.length > MAX_CONNECTIONS) errors.push(`Save no more than ${MAX_CONNECTIONS} agent connections.`);

  const labels = new Set<string>();
  const connectionIds = new Set<string>();
  for (const connection of value.connections) {
    const label = connection.label.trim();
    if (!label) errors.push("Every agent connection needs a name.");
    else if (connection.label !== label) errors.push(`“${label}” cannot start or end with whitespace.`);
    else if (label.length > 80) errors.push(`“${label.slice(0, 40)}…” must be 80 characters or fewer.`);
    else if (CONTROL_CHARACTER.test(label)) errors.push(`“${label.replace(CONTROL_CHARACTER, "")}” contains an unsupported control character.`);
    const folded = label.toLocaleLowerCase();
    if (label && labels.has(folded)) errors.push(`Connection names must be unique; “${label}” is repeated.`);
    labels.add(folded);
    if (!CONNECTION_ID.test(connection.id) || connectionIds.has(connection.id)) {
      errors.push(`“${label || "Unnamed connection"}” has an invalid or duplicate connection id.`);
    }
    connectionIds.add(connection.id);
    if (connection.provider === "openai" && !connection.baseUrl.trim()) {
      errors.push(`“${label || "Unnamed connection"}” needs a server URL.`);
    } else if (connection.provider === "openai") {
      const urlError = providerUrlError(connection.baseUrl);
      if (urlError) errors.push(`“${label || "Unnamed connection"}”: ${urlError}`);
      else {
        if (isKnownKeyedOpenAIEndpoint(connection.baseUrl) && !connection.requiresKey) {
          errors.push(`“${label || "Unnamed connection"}” must require a key because it uses a built-in hosted provider endpoint.`);
        }
      }
    } else if (!connection.requiresKey) {
      errors.push(`“${label || "Unnamed connection"}” must require an Anthropic API key.`);
    }
    if (connection.models.length === 0) errors.push(`“${label || "Unnamed connection"}” needs at least one saved model.`);
    if (connection.models.length > MAX_MODELS) errors.push(`“${label || "Unnamed connection"}” has more than ${MAX_MODELS} saved models.`);
    if (new Set(connection.models).size !== connection.models.length) errors.push(`“${label || "Unnamed connection"}” has duplicate model ids.`);
    for (const model of connection.models) {
      const modelError = modelValidationError(model);
      if (modelError) errors.push(`“${label || "Unnamed connection"}” model: ${modelError}`);
    }
  }

  const activeConnection = value.connections.find((connection) => connection.id === value.active.connectionId);
  if (!activeConnection || !activeConnection.models.includes(value.active.model)) {
    errors.push("Choose an active model that belongs to a saved connection.");
  }
  return [...new Set(errors)];
}

/** Empty is the explicit clear operation; non-empty credentials must survive
 * renderer-to-main transport byte-for-byte rather than being silently trimmed. */
export function agentCredentialInputError(value: string): string | null {
  if (value.length > 4096) return "API keys must be 4,096 characters or fewer.";
  if (value !== value.trim()) return "API keys cannot start or end with whitespace.";
  if (CONTROL_CHARACTER.test(value)) return "API keys cannot contain control characters.";
  return null;
}

function isNumericLoopback(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 &&
    octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127;
}

function parsedProviderUrl(value: string): URL | null {
  if (value.length > 2048) return null;
  try { return new URL(value); } catch { return null; }
}

function providerUrlError(value: string): string | null {
  if (value.length > 2048) return "Server URL must be 2,048 characters or fewer.";
  const url = parsedProviderUrl(value);
  if (!url) return "Server URL is not a valid URL.";
  if (url.username || url.password) return "Server URL must not contain embedded credentials.";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isNumericLoopback(url.hostname)) return null;
  return "Server URL must use HTTPS, unless it points to a numeric loopback address.";
}

function modelValidationError(value: string): string | null {
  if (value.length > 256) return "Model ids must be 256 characters or fewer.";
  if (!value.trim()) return "Model ids cannot be blank.";
  if (value !== value.trim()) return "Model ids cannot start or end with whitespace.";
  if (CONTROL_CHARACTER.test(value)) return "Model ids cannot contain control characters.";
  return null;
}

function authScope(connection: AgentConnection): string {
  let endpoint = connection.baseUrl.trim();
  if (connection.provider === "openai") {
    try {
      endpoint = new URL(endpoint).toString();
    } catch {
      // Preserve the exact invalid draft so it cannot accidentally inherit a
      // credential from a different, valid endpoint while the user is editing.
    }
  }
  return JSON.stringify([
    connection.provider,
    connection.provider === "anthropic" ? "" : endpoint,
    connection.requiresKey,
  ]);
}

function modelResult(value: AgentModelListResult | string[]): AgentModelListResult {
  return Array.isArray(value) ? { ok: true, models: value } : value;
}

function uniqueConnectionLabel(connections: AgentConnection[], preferred: string): string {
  const used = new Set(connections.map((connection) => connection.label.trim().toLocaleLowerCase()));
  if (!used.has(preferred.toLocaleLowerCase())) return preferred;
  for (let suffix = 2; suffix <= MAX_CONNECTIONS + 1; suffix += 1) {
    const candidate = `${preferred} ${suffix}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${preferred} copy`;
}

function newConnectionId(existing: AgentConnection[]): string {
  const used = new Set(existing.map((connection) => connection.id));
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId && !used.has(randomId)) return randomId;
  let suffix = Date.now().toString(36);
  while (used.has(`connection-${suffix}`)) suffix += "x";
  return `connection-${suffix}`;
}

function cleanModels(models: string[]): string[] {
  return [...new Set(models.filter((model) => !modelValidationError(model)))];
}

function focusAfterRender(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

export default function AgentConnectionsEditor({
  value,
  savedValue,
  keyStages,
  disabled,
  onChange,
  onKeyStagesChange,
  onBusyChange,
}: AgentConnectionsEditorProps) {
  const [selectedId, setSelectedId] = useState(value.active.connectionId || value.connections[0]?.id || "");
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [hasSavedKey, setHasSavedKey] = useState<boolean | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [toolCapable, setToolCapable] = useState<Record<string, boolean> | undefined>();
  const [availableSelection, setAvailableSelection] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelNotice, setModelNotice] = useState<{ text: string; error: boolean } | null>(null);
  const modelRequestId = useRef(0);

  const selected = value.connections.find((connection) => connection.id === selectedId) ?? value.connections[0];
  const saved = selected && savedValue.connections.find((connection) => connection.id === selected.id);
  const scopeMatchesSaved = Boolean(selected && saved && authScope(selected) === authScope(saved));
  const keyStage = selected ? keyStages[selected.id] : undefined;
  const selectedPreset = selected ? matchPreset(selected.provider, selected.baseUrl) : DEFAULT_GEMINI;
  const validationErrors = validateAgentSettings(value);
  const selectedLabel = selected?.label.trim() ?? "";
  const selectedLabelRepeated = selectedLabel !== "" && value.connections.filter(
    (connection) => connection.label.trim().toLocaleLowerCase() === selectedLabel.toLocaleLowerCase(),
  ).length > 1;
  const selectedLabelError = !selectedLabel
    ? "Enter a connection name."
    : selected?.label !== selectedLabel
      ? "Connection names cannot start or end with whitespace."
    : selectedLabel.length > 80
      ? "Use 80 characters or fewer."
      : CONTROL_CHARACTER.test(selectedLabel)
        ? "Connection names cannot contain control characters."
    : selectedLabelRepeated
      ? "Use a unique connection name."
      : null;
  const selectedUrlError = selected?.provider === "openai" ? providerUrlError(selected.baseUrl) : null;
  const selectedIsNumericLoopback = selected?.provider === "openai" &&
    Boolean(parsedProviderUrl(selected.baseUrl) && isNumericLoopback(parsedProviderUrl(selected.baseUrl)!.hostname));
  const selectedRequiresKey = Boolean(selected?.requiresKey);
  const selectedKeyError = keyStage?.kind === "replace" ? agentCredentialInputError(keyStage.value) : null;
  const manualModelError = manualModel ? modelValidationError(manualModel) : null;

  function invalidateModelDiscovery() {
    modelRequestId.current += 1;
    setAvailableModels([]);
    setAvailableSelection("");
    setToolCapable(undefined);
    setModelNotice(null);
  }

  useEffect(() => {
    if (!selected && value.connections[0]) setSelectedId(value.connections[0].id);
  }, [selected, value.connections]);

  useEffect(() => {
    invalidateModelDiscovery();
  }, [
    selected?.id,
    selected?.provider,
    selected?.baseUrl,
    selectedRequiresKey,
    keyStage?.kind,
    keyStage?.kind === "replace" ? keyStage.value : keyStage?.reason,
  ]);

  useEffect(() => {
    let cancelled = false;
    setHasSavedKey(null);
    if (!selected) return () => { cancelled = true; };
    if (!saved) {
      setHasSavedKey(false);
      return () => { cancelled = true; };
    }
    if (!scopeMatchesSaved) return () => { cancelled = true; };
    void window.api.agent.hasConnectionKey(selected.id)
      .then((has) => {
        if (!cancelled) setHasSavedKey(has);
      })
      .catch(() => {
        if (!cancelled) setHasSavedKey(false);
      });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.provider, selected?.baseUrl, saved?.id, scopeMatchesSaved]);

  function emitConnection(next: AgentConnection) {
    let normalizedNext = next;
    if (
      normalizedNext.provider === "openai" &&
      isKnownKeyedOpenAIEndpoint(normalizedNext.baseUrl) &&
      !normalizedNext.requiresKey
    ) {
      normalizedNext = { ...normalizedNext, requiresKey: true };
    }
    const connections = value.connections.map((connection) => connection.id === normalizedNext.id ? normalizedNext : connection);
    const active = value.active.connectionId === normalizedNext.id && !normalizedNext.models.includes(value.active.model)
      ? { connectionId: normalizedNext.id, model: normalizedNext.models[0] ?? "" }
      : value.active;
    onChange({ ...value, connections, active });

    const scopeChanged = authScope(normalizedNext) !== authScope(selected);
    if (scopeChanged) invalidateModelDiscovery();
    if (!scopeChanged && !saved) return;

    const nextStages = { ...keyStages };
    let nextStage = nextStages[normalizedNext.id];
    // A typed credential belongs only to the exact provider/endpoint for which
    // it was entered. Never carry it across a later draft scope edit.
    if (scopeChanged && nextStage?.kind === "replace") nextStage = undefined;

    if (saved) {
      const nextMatchesSaved = authScope(normalizedNext) === authScope(saved);
      if (scopeChanged && !nextMatchesSaved) nextStage = { kind: "clear", reason: "scope-change" };
      else if (nextMatchesSaved && nextStage?.kind === "clear" && nextStage.reason === "scope-change") nextStage = undefined;
    }

    if (nextStage) nextStages[normalizedNext.id] = nextStage;
    else delete nextStages[normalizedNext.id];
    if (nextStage !== keyStages[normalizedNext.id]) onKeyStagesChange(nextStages);
  }

  function applyPreset(id: string) {
    if (!selected) return;
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === id);
    if (!preset) return;
    if (preset.id === "custom") {
      // A preset is inferred from the endpoint rather than stored. Clear a
      // built-in endpoint so Custom stays selected while its URL is entered.
      emitConnection({ ...selected, provider: "openai", baseUrl: "", requiresKey: preset.needsKey });
      return;
    }
    const models = preset.model ? [preset.model] : [];
    emitConnection({
      ...selected,
      provider: preset.id === "anthropic" ? "anthropic" : "openai",
      baseUrl: preset.id === "anthropic" ? "" : preset.baseUrl,
      models,
      requiresKey: preset.needsKey,
    });
  }

  function addConnection() {
    if (value.connections.length >= MAX_CONNECTIONS) return;
    const connection: AgentConnection = {
      id: newConnectionId(value.connections),
      label: uniqueConnectionLabel(value.connections, DEFAULT_GEMINI.label),
      provider: "openai",
      baseUrl: DEFAULT_GEMINI.baseUrl,
      models: [DEFAULT_GEMINI.model].filter(Boolean),
      requiresKey: DEFAULT_GEMINI.needsKey,
    };
    onChange({ ...value, connections: [...value.connections, connection] });
    setSelectedId(connection.id);
    setRemoveConfirmId(null);
    focusAfterRender(`agent-connection-label-${connection.id}`);
  }

  function removeConnection(id: string) {
    if (value.connections.length <= 1) return;
    const connections = value.connections.filter((connection) => connection.id !== id);
    const fallback = connections[0];
    const active = value.active.connectionId === id
      ? { connectionId: fallback.id, model: fallback.models[0] ?? "" }
      : value.active;
    onChange({ ...value, connections, active });
    const nextStages = { ...keyStages };
    delete nextStages[id];
    onKeyStagesChange(nextStages);
    setSelectedId(fallback.id);
    setRemoveConfirmId(null);
    focusAfterRender(`agent-connection-choice-${fallback.id}`);
  }

  function stageKey(valueText: string) {
    if (!selected) return;
    const nextStages = { ...keyStages };
    invalidateModelDiscovery();
    if (valueText === "") {
      if (saved && !scopeMatchesSaved) nextStages[selected.id] = { kind: "clear", reason: "scope-change" };
      else delete nextStages[selected.id];
    }
    else nextStages[selected.id] = { kind: "replace", value: valueText };
    onKeyStagesChange(nextStages);
  }

  function clearKey() {
    if (!selected) return;
    invalidateModelDiscovery();
    onKeyStagesChange({ ...keyStages, [selected.id]: { kind: "clear", reason: "explicit" } });
  }

  function undoKeyChange() {
    if (!selected) return;
    invalidateModelDiscovery();
    const nextStages = { ...keyStages };
    if (saved && !scopeMatchesSaved) nextStages[selected.id] = { kind: "clear", reason: "scope-change" };
    else delete nextStages[selected.id];
    onKeyStagesChange(nextStages);
  }

  async function loadModels() {
    if (!selected || loadingModels) return;
    if (selectedKeyError) {
      setModelNotice({ text: selectedKeyError, error: true });
      return;
    }
    const currentRequest = ++modelRequestId.current;
    setLoadingModels(true);
    onBusyChange(true);
    setModelNotice({ text: `Loading models for ${selected.label || "this connection"}…`, error: false });
    try {
      const useSavedConnection = Boolean(saved && scopeMatchesSaved && !keyStage);
      const raw = useSavedConnection
        ? await window.api.agent.listConnectionModels(selected.id)
        : await window.api.agent.probeModels(
            { provider: selected.provider, baseUrl: selected.baseUrl, requiresKey: selectedRequiresKey },
            keyStage?.kind === "replace" ? keyStage.value || undefined : undefined,
          );
      if (modelRequestId.current !== currentRequest) return;
      const result = modelResult(raw);
      if (!result.ok || !result.models) throw new Error(result.error || "Could not load models.");
      const models = cleanModels(result.models);
      setAvailableModels(models);
      setToolCapable(result.toolCapable);
      setAvailableSelection(models.find((model) => result.toolCapable?.[model] !== false) ?? models[0] ?? "");
      setModelNotice({
        text: models.length === 0
          ? "The connection returned no models. Add a model id manually."
          : `Loaded ${models.length} model${models.length === 1 ? "" : "s"}.`,
        error: models.length === 0,
      });
    } catch (error) {
      if (modelRequestId.current !== currentRequest) return;
      setAvailableModels([]);
      setToolCapable(undefined);
      setAvailableSelection("");
      setModelNotice({ text: (error as Error).message || "Could not load models.", error: true });
    } finally {
      if (modelRequestId.current === currentRequest) {
        setLoadingModels(false);
        onBusyChange(false);
      }
    }
  }

  function addModels(models: string[], fillRemainingSlots = false) {
    if (!selected) return;
    const current = cleanModels(selected.models);
    const currentSet = new Set(current);
    const additions = cleanModels(models).filter((model) => !currentSet.has(model));
    const remainingSlots = Math.max(0, MAX_MODELS - current.length);
    if (!fillRemainingSlots && additions.length > remainingSlots) {
      setModelNotice({ text: `A connection can save at most ${MAX_MODELS} models.`, error: true });
      return;
    }
    const accepted = additions.slice(0, remainingSlots);
    const omitted = additions.length - accepted.length;
    const next = [...current, ...accepted];
    emitConnection({ ...selected, models: next });
    setManualModel("");
    setModelNotice({
      text: omitted > 0
        ? `Added ${accepted.length} usable model${accepted.length === 1 ? "" : "s"}; ${omitted} more did not fit in the ${MAX_MODELS}-model save limit.`
        : accepted.length === 0
          ? "Those models are already saved, or this connection has reached its model limit."
          : `Added ${accepted.length} model${accepted.length === 1 ? "" : "s"} for ${selected.label}.`,
      error: accepted.length === 0 && additions.length > 0,
    });
  }

  function removeModel(model: string) {
    if (!selected || selected.models.length <= 1) return;
    emitConnection({ ...selected, models: selected.models.filter((candidate) => candidate !== model) });
    focusAfterRender(`agent-manual-model-${selected.id}`);
  }

  if (!selected) return null;

  const keyInputValue = keyStage?.kind === "replace" ? keyStage.value : "";
  const keyDescription = keyStage?.kind === "replace"
    ? "A replacement key is staged and will be stored only after Settings is saved."
    : keyStage?.kind === "clear"
      ? keyStage.reason === "scope-change"
        ? "The previously saved key does not apply after this provider or endpoint change. Enter a replacement or leave it cleared."
        : "The saved key will be removed after Settings is saved."
      : !scopeMatchesSaved && saved
        ? "The previously saved key does not apply to this edited provider or endpoint."
          : hasSavedKey === null
            ? "Checking for a saved key…"
            : hasSavedKey
              ? "A key is saved. Leave this field blank to keep it unchanged."
              : "No key is saved for this connection.";
  const canClearKey = keyStage?.kind === "replace" || (scopeMatchesSaved && hasSavedKey === true);
  const usableAvailable = availableModels.filter((model) => toolCapable?.[model] !== false);

  return (
    <section className="agent-connections" aria-labelledby="agent-connections-title" aria-busy={loadingModels}>
      <div className="agent-connections-heading">
        <div>
          <h4 id="agent-connections-title">Saved agent connections</h4>
          <p>
            Each named connection keeps its own models and, when needed, its own encrypted key; local connections
            default to keyless. Add another connection to use another account, even with the same provider, then
            choose which connection and model Agent Chat uses.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={addConnection}
          disabled={disabled || value.connections.length >= MAX_CONNECTIONS}
        >
          Add connection
        </button>
      </div>

      <div className="agent-connections-layout">
        <div className="agent-connection-list" role="list" aria-label="Saved agent connections">
          {value.connections.map((connection) => (
            <div role="listitem" key={connection.id}>
              <button
                id={`agent-connection-choice-${connection.id}`}
                type="button"
                className={`agent-connection-choice ${connection.id === selected.id ? "selected" : ""}`}
                aria-pressed={connection.id === selected.id}
                onClick={() => {
                  setSelectedId(connection.id);
                  setRemoveConfirmId(null);
                }}
                disabled={disabled}
              >
                <span>{connection.label || "Unnamed connection"}</span>
                <small>
                  {connection.provider === "anthropic" ? "Anthropic" : matchPreset(connection.provider, connection.baseUrl).label}
                  {value.active.connectionId === connection.id ? " · Active" : ""}
                </small>
              </button>
            </div>
          ))}
        </div>

        <fieldset className="agent-connection-editor" disabled={disabled}>
          <legend>Edit {selected.label || "connection"}</legend>

          <label className="field-label" htmlFor={`agent-connection-label-${selected.id}`}>Connection name</label>
          <input
            id={`agent-connection-label-${selected.id}`}
            value={selected.label}
            maxLength={80}
            aria-invalid={selectedLabelError ? "true" : undefined}
            aria-describedby={`agent-connection-label-help-${selected.id}${selectedLabelError ? ` agent-connection-label-error-${selected.id}` : ""}`}
            onChange={(event) => emitConnection({ ...selected, label: event.target.value })}
          />
          <div className="field-hint" id={`agent-connection-label-help-${selected.id}`}>Use a unique name that will make sense in the Agent Chat model picker.</div>
          {selectedLabelError && <div className="error-text" id={`agent-connection-label-error-${selected.id}`}>{selectedLabelError}</div>}

          <label className="field-label" htmlFor={`agent-connection-preset-${selected.id}`}>Provider preset</label>
          <select
            id={`agent-connection-preset-${selected.id}`}
            value={selectedPreset.id}
            aria-describedby={`agent-connection-preset-help-${selected.id}`}
            onChange={(event) => applyPreset(event.target.value)}
          >
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label} — {COST_LABEL[preset.cost]}</option>
            ))}
          </select>
          <div className="field-hint" id={`agent-connection-preset-help-${selected.id}`}>
            {selectedPreset.note}
            {selectedPreset.keyUrl && (
              <>
                {" "}
                <a
                  href={selectedPreset.keyUrl}
                  onClick={(event) => {
                    event.preventDefault();
                    void window.api.shell.openExternal(selectedPreset.keyUrl!);
                  }}
                >Get a key</a>
              </>
            )}
          </div>

          {selected.provider === "openai" && (
            <>
              <label className="field-label" htmlFor={`agent-connection-url-${selected.id}`}>Server URL</label>
              <input
                id={`agent-connection-url-${selected.id}`}
                value={selected.baseUrl}
                placeholder="https://…/v1"
                aria-invalid={selectedUrlError ? "true" : undefined}
                aria-describedby={`agent-connection-url-help-${selected.id}${selectedUrlError ? ` agent-connection-url-error-${selected.id}` : ""}`}
                onChange={(event) => emitConnection({ ...selected, baseUrl: event.target.value })}
              />
              <div className="field-hint" id={`agent-connection-url-help-${selected.id}`}>Changing the endpoint disconnects the old saved key from this connection.</div>
              {selectedUrlError && <div className="error-text" id={`agent-connection-url-error-${selected.id}`}>{selectedUrlError}</div>}
            </>
          )}

          {selected.provider === "openai" && (selectedPreset.id === "custom" || selectedIsNumericLoopback) && (
            <div className="agent-key-requirement">
              <label htmlFor={`agent-connection-requires-key-${selected.id}`}>
                <input
                  id={`agent-connection-requires-key-${selected.id}`}
                  type="checkbox"
                  checked={selected.requiresKey}
                  aria-describedby={`agent-connection-requires-key-help-${selected.id}`}
                  onChange={(event) => emitConnection({ ...selected, requiresKey: event.target.checked })}
                />
                <span>This connection requires an API key</span>
              </label>
              <div className="field-hint" id={`agent-connection-requires-key-help-${selected.id}`}>
                {selectedIsNumericLoopback
                  ? "Local model servers are keyless by default; enable this only if yours requires authentication."
                  : "Enable this for hosted endpoints that must have a saved key before Agent Chat can send."}
              </div>
            </div>
          )}

          {selectedRequiresKey ? (
            <>
              <label className="field-label" htmlFor={`agent-connection-key-${selected.id}`}>API key</label>
              <div className="field-row agent-key-row">
                <input
                  id={`agent-connection-key-${selected.id}`}
                  type="password"
                  value={keyInputValue}
                  maxLength={4096}
                  spellCheck={false}
                  autoComplete="new-password"
                  placeholder="Paste a key"
                  aria-invalid={selectedKeyError ? "true" : undefined}
                  aria-describedby={`agent-connection-key-help-${selected.id}${selectedKeyError ? ` agent-connection-key-error-${selected.id}` : ""}`}
                  onChange={(event) => stageKey(event.target.value)}
                />
                {keyStage && !(keyStage.kind === "clear" && keyStage.reason === "scope-change") && (
                  <button type="button" className="btn" onClick={undoKeyChange}>
                    Undo key change
                  </button>
                )}
                {!keyStage && canClearKey && (
                  <button type="button" className="btn" onClick={clearKey} aria-label={`Remove saved API key for ${selected.label}`}>
                    Remove saved key
                  </button>
                )}
              </div>
              <div className="field-hint" id={`agent-connection-key-help-${selected.id}`} role="status" aria-live="polite">
                {keyDescription}
              </div>
              {selectedKeyError && (
                <div className="error-text" id={`agent-connection-key-error-${selected.id}`}>{selectedKeyError}</div>
              )}
            </>
          ) : (
            <div className="field-hint agent-keyless-notice" role="status">
              This connection is keyless. QB Studio never stores or sends an API key for it.
            </div>
          )}

          <div className="agent-model-heading">
            <div>
              <h5>Models</h5>
              <p>The agent requires a model with reliable tool calling.</p>
            </div>
            <button type="button" className="btn" onClick={() => void loadModels()} disabled={loadingModels || Boolean(selectedKeyError)}>
              {loadingModels ? "Loading models…" : "Load available models"}
            </button>
          </div>

          {availableModels.length > 0 && (
            <div className="agent-available-models">
              <label className="field-label" htmlFor={`agent-available-model-${selected.id}`}>Available model</label>
              <div className="field-row">
                <select
                  id={`agent-available-model-${selected.id}`}
                  value={availableSelection}
                  onChange={(event) => setAvailableSelection(event.target.value)}
                >
                  {availableModels.map((model) => (
                    <option key={model} value={model} disabled={toolCapable?.[model] === false}>
                      {model}{toolCapable?.[model] === false ? " — no tool support" : ""}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn" onClick={() => addModels([availableSelection])} disabled={!availableSelection || selected.models.length >= MAX_MODELS}>
                  Add selected model
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => addModels(usableAvailable, true)}
                  disabled={usableAvailable.length === 0 || selected.models.length >= MAX_MODELS}
                  aria-describedby={`agent-add-usable-help-${selected.id}`}
                >
                  Add usable models
                </button>
              </div>
              <div className="field-hint" id={`agent-add-usable-help-${selected.id}`}>
                Adds as many tool-capable results as will fit in the {MAX_MODELS}-model save limit; any remainder is reported here.
              </div>
            </div>
          )}

          <label className="field-label" htmlFor={`agent-manual-model-${selected.id}`}>Add a model id manually</label>
          <div className="field-row">
            <input
              id={`agent-manual-model-${selected.id}`}
              value={manualModel}
              maxLength={256}
              placeholder="model id"
              aria-invalid={manualModelError ? "true" : undefined}
              aria-describedby={manualModelError ? `agent-manual-model-error-${selected.id}` : undefined}
              onChange={(event) => setManualModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && manualModel.trim() && !manualModelError) {
                  event.preventDefault();
                  addModels([manualModel]);
                }
              }}
            />
            <button type="button" className="btn" onClick={() => addModels([manualModel])} disabled={!manualModel.trim() || Boolean(manualModelError) || selected.models.length >= MAX_MODELS}>
              Add model
            </button>
          </div>
          {manualModelError && <div className="error-text" id={`agent-manual-model-error-${selected.id}`}>{manualModelError}</div>}

          {modelNotice && (
            <div className={modelNotice.error ? "error-text" : "field-hint"} role={modelNotice.error ? "alert" : "status"} aria-live="polite">
              {modelNotice.text}
            </div>
          )}

          <ul className="agent-saved-models" aria-label={`Saved models for ${selected.label}`}>
            {selected.models.map((model) => {
              const active = value.active.connectionId === selected.id && value.active.model === model;
              return (
                <li key={model}>
                  <label>
                    <input
                      type="radio"
                      name="active-agent-model"
                      checked={active}
                      onChange={() => onChange({ ...value, active: { connectionId: selected.id, model } })}
                    />
                    <span>{model}</span>
                    {active && <small>Active in Agent Chat</small>}
                  </label>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => removeModel(model)}
                    disabled={selected.models.length <= 1}
                    aria-label={`Remove model ${model} from ${selected.label}`}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          {selected.models.length === 0 && <div className="error-text">Add at least one saved model for this connection.</div>}
          {selected.models.length === 1 && <div className="field-hint">Add another model before removing the only saved model.</div>}

          <div className="agent-connection-remove">
            {removeConfirmId === selected.id ? (
              <div className="agent-remove-confirm" role="alert">
                <span>
                  Remove “{selected.label}” and its saved model choices?
                  {selected.requiresKey ? " Its saved API key will also be deleted when Settings is saved." : ""}
                </span>
                <button
                  id={`agent-keep-connection-${selected.id}`}
                  type="button"
                  className="btn"
                  onClick={() => {
                    setRemoveConfirmId(null);
                    focusAfterRender(`agent-remove-connection-${selected.id}`);
                  }}
                >
                  Keep connection
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => removeConnection(selected.id)}
                  aria-label={`Remove ${selected.label}${selected.requiresKey ? ", its models, and its saved API key" : " and its models"}`}
                >
                  {selected.requiresKey ? "Remove connection and key" : "Remove connection"}
                </button>
              </div>
            ) : (
              <button
                id={`agent-remove-connection-${selected.id}`}
                type="button"
                className="btn"
                onClick={() => {
                  setRemoveConfirmId(selected.id);
                  focusAfterRender(`agent-keep-connection-${selected.id}`);
                }}
                disabled={value.connections.length <= 1}
                aria-label={`Remove saved connection ${selected.label}`}
              >
                Remove connection
              </button>
            )}
            {value.connections.length <= 1 && <span className="field-hint">Keep at least one saved connection.</span>}
          </div>
        </fieldset>
      </div>

      {validationErrors.length > 0 && (
        <div className="agent-connections-validation" role="status" aria-live="polite">
          <strong>Finish the agent connection setup before saving:</strong>
          <ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul>
        </div>
      )}
    </section>
  );
}
