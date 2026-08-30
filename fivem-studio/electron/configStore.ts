// Tiny JSON config store — where QB Studio remembers the user's local
// workspace and client path between launches.
// Deliberately not using a dependency for this; it's ~20 lines of fs code.

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app, safeStorage } from "electron";
import { isKnownKeyedOpenAIEndpoint } from "./agentProviderPolicy";
import { isLoopbackHostname, parseProviderUrl, providerUrlOr } from "./localUrl";
import { NativeFileTransaction, recoverNativeFileTransaction } from "./nativeFileTransaction";
import {
  buildCredentialMutationPlan,
  type CredentialConnectionIdentity,
} from "./credentialMutationPlan";

export type AgentProviderKind = "anthropic" | "openai";
export type AgentProvider = AgentProviderKind;

export interface AgentConnection {
  id: string;
  label: string;
  provider: AgentProvider;
  /** Empty for Anthropic, whose native endpoint is not user-configurable. */
  baseUrl: string;
  /** Models this connection should offer in the chat model picker. */
  models: string[];
  requiresKey: boolean;
}

export interface AgentTarget {
  connectionId: string;
  model: string;
}

export interface ConnectionKeyUpdate {
  connectionId: string;
  /** Empty is the explicit clear operation. */
  key: string;
}

export type AgentSelection = AgentTarget;

export interface AgentSettings {
  schemaVersion: 1;
  connections: AgentConnection[];
  active: AgentTarget;
  /** Public cache-buster only. Credential values remain main-process-only. */
  credentialRevision: number;
}

export interface StudioConfig {
  txDataPath: string | null; // path to the txAdmin txData folder (holds one subfolder per server profile)
  selectedProfile: string | null; // which txData/<profile> to browse/edit
  theme: ThemePreference;
  uiScale: number;
  activeCfxTarget: CfxTarget;
  legacyFivemExePath: string | null;
  enhancedFivemExePath: string | null;
  redmClientExePath: string | null;
  legacyFxServerExePath: string | null;
  enhancedFxServerExePath: string | null;
  redmFxServerExePath: string | null;
  legacyArtifactTrack: "recommended" | "latest";
  redmArtifactTrack: "recommended" | "latest";
  consoleRefreshIntervalMs: number;
  notifyOnServerExit: boolean;
  discordPresenceEnabled: boolean;
  agentSpendWarningUsd: number;
  editor: EditorPreferences;
  // --- agent chat backends (no secrets here: this object is sent to the renderer) ---
  agent: AgentSettings;
}

export interface EditorPreferences {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  formatOnSave: boolean;
  restartResourceOnSave: boolean;
  luaIntelligence: "off" | "balanced" | "full";
}

export type CfxTarget = "legacy" | "enhanced" | "redm";
export type BuiltInThemePreference = "system" | "dark" | "light" | "high-contrast";
export type ThemePreference = BuiltInThemePreference | `custom:${string}`;

export const CFX_TARGETS: readonly CfxTarget[] = ["legacy", "enhanced", "redm"];

export const MAX_AGENT_CONNECTIONS = 32;
export const MAX_MODELS_PER_CONNECTION = 64;
export const MAX_CREDENTIAL_REVISION = 2_147_483_647;
export const DEFAULT_AGENT_CONNECTION_ID = "google-gemini-default";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
export const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

function defaultAgentSettings(): AgentSettings {
  return {
    schemaVersion: 1,
    connections: [{
      id: DEFAULT_AGENT_CONNECTION_ID,
      label: "Google Gemini",
      provider: "openai",
      baseUrl: DEFAULT_GEMINI_BASE_URL,
      models: [DEFAULT_GEMINI_MODEL],
      requiresKey: true,
    }],
    active: { connectionId: DEFAULT_AGENT_CONNECTION_ID, model: DEFAULT_GEMINI_MODEL },
    credentialRevision: 0,
  };
}

const DEFAULTS: StudioConfig = {
  txDataPath: null,
  selectedProfile: null,
  theme: "system",
  uiScale: 1,
  activeCfxTarget: "legacy",
  legacyFivemExePath: null,
  enhancedFivemExePath: null,
  redmClientExePath: null,
  legacyFxServerExePath: null,
  enhancedFxServerExePath: null,
  redmFxServerExePath: null,
  legacyArtifactTrack: "recommended",
  redmArtifactTrack: "recommended",
  consoleRefreshIntervalMs: 2_000,
  notifyOnServerExit: true,
  discordPresenceEnabled: false,
  agentSpendWarningUsd: 5,
  editor: {
    fontSize: 13,
    wordWrap: false,
    minimap: false,
    stickyScroll: true,
    formatOnSave: false,
    restartResourceOnSave: false,
    luaIntelligence: "balanced",
  },
  // Defaults to Google's free tier rather than a paid key or a local model the
  // user may not have installed — the least-friction way to a working agent.
  agent: defaultAgentSettings(),
};

function configPath(): string {
  return path.join(app.getPath("userData"), "qb-studio.config.json");
}

function previousProductUserDataPaths(): string[] {
  return [
    path.join(app.getPath("appData"), "Ghz Workbench"),
    path.join(app.getPath("appData"), "ghz-workbench"),
  ];
}

const CREDENTIAL_FILE_NAME = /^(?:anthropic|provider-[A-Za-z0-9_]{1,80}|agent-connection-[a-f0-9]{64})-key\.bin$/;

/** Finish an interrupted credential/config commit before any public settings
 * are loaded. Journal paths are limited to direct credential files in the
 * current and explicitly supported former product directories. */
export function recoverConfigTransaction(): void {
  const allowedDirectories = new Set(
    [app.getPath("userData"), ...previousProductUserDataPaths()]
      .map((directory) => fileIdentity(directory)),
  );
  recoverNativeFileTransaction(configPath(), {
    isPrivatePathAllowed(candidate) {
      return CREDENTIAL_FILE_NAME.test(path.basename(candidate)) &&
        allowedDirectories.has(fileIdentity(path.dirname(candidate)));
    },
  });
}

function configCandidates(): string[] {
  return [...new Set([
    configPath(),
    path.join(app.getPath("userData"), "ghz-workbench.config.json"),
    path.join(app.getPath("userData"), "fivem-studio.config.json"),
    ...previousProductUserDataPaths().flatMap((directory) => [
      path.join(directory, "ghz-workbench.config.json"),
      path.join(directory, "fivem-studio.config.json"),
    ]),
  ])];
}

interface PersistedConfigDocument {
  raw: unknown;
  path: string;
}

function readPersistedConfig(): PersistedConfigDocument | null {
  const target = configCandidates().find((candidate) => fs.existsSync(candidate));
  if (!target) return null;
  return { raw: JSON.parse(fs.readFileSync(target, "utf8")), path: target };
}

export function loadConfig(): StudioConfig {
  try {
    const persisted = readPersistedConfig();
    return normalizePersistedConfig(persisted);
  } catch {
    return normalizeConfig({});
  }
}

/** Validate untrusted renderer/config-file data and persist only public settings.
 * Credentials have a separate write-only store below. */
export function saveConfig(config: unknown): StudioConfig {
  return saveConfigWithConnectionKeys(config, []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullablePath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 32767 && path.isAbsolute(value) ? value : null;
}

function safeProfile(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 255 || value === "." || value === "..") return null;
  return path.basename(value) === value && !/[<>:"/\\|?*\u0000-\u001f]/.test(value) ? value : null;
}

const CONSOLE_REFRESH_INTERVALS = new Set([0, 1_000, 2_000, 5_000, 10_000, 30_000]);

function consoleRefreshIntervalOrDefault(value: unknown): number {
  return typeof value === "number" && CONSOLE_REFRESH_INTERVALS.has(value)
    ? value
    : DEFAULTS.consoleRefreshIntervalMs;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function themePreferenceOrDefault(value: unknown): ThemePreference {
  if (value === "system" || value === "dark" || value === "light" || value === "high-contrast") return value;
  if (typeof value === "string" && /^custom:[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value)) return value as ThemePreference;
  return DEFAULTS.theme;
}

const UI_SCALES = new Set([0.8, 0.9, 1, 1.1, 1.25, 1.5]);
const SPEND_WARNING_USD = new Set([0, 1, 2, 5, 10, 20]);

function uiScaleOrDefault(value: unknown): number {
  return typeof value === "number" && UI_SCALES.has(value) ? value : DEFAULTS.uiScale;
}

function spendWarningOrDefault(value: unknown): number {
  return typeof value === "number" && SPEND_WARNING_USD.has(value) ? value : DEFAULTS.agentSpendWarningUsd;
}

function editorPreferences(value: unknown): EditorPreferences {
  const raw = isRecord(value) ? value : {};
  const fontSize = typeof raw.fontSize === "number" && Number.isInteger(raw.fontSize) && raw.fontSize >= 11 && raw.fontSize <= 24
    ? raw.fontSize
    : DEFAULTS.editor.fontSize;
  return {
    fontSize,
    wordWrap: booleanOr(raw.wordWrap, DEFAULTS.editor.wordWrap),
    minimap: booleanOr(raw.minimap, DEFAULTS.editor.minimap),
    stickyScroll: booleanOr(raw.stickyScroll, DEFAULTS.editor.stickyScroll),
    formatOnSave: booleanOr(raw.formatOnSave, DEFAULTS.editor.formatOnSave),
    restartResourceOnSave: booleanOr(raw.restartResourceOnSave, DEFAULTS.editor.restartResourceOnSave),
    luaIntelligence:
      raw.luaIntelligence === "off" || raw.luaIntelligence === "full" ? raw.luaIntelligence : "balanced",
  };
}

const AGENT_CONNECTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function validConnectionId(value: unknown): value is string {
  return typeof value === "string" && AGENT_CONNECTION_ID.test(value);
}

function normalizedModel(value: unknown): string | null {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) return null;
  const model = value.trim();
  return model && model.length <= 256 ? model : null;
}

function normalizedModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const models: string[] = [];
  const seen = new Set<string>();
  // Stop inspecting once no more values can affect the bounded public output.
  for (const candidate of value) {
    const model = normalizedModel(candidate);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
    if (models.length === MAX_MODELS_PER_CONNECTION) break;
  }
  return models;
}

function normalizeAgentConnection(value: unknown): AgentConnection | null {
  if (!isRecord(value) || !validConnectionId(value.id)) return null;
  if (typeof value.label !== "string") return null;
  const label = value.label.trim();
  if (!label || label.length > 80 || CONTROL_CHARACTER.test(label)) return null;
  if (value.provider !== "openai" && value.provider !== "anthropic") return null;

  const models = normalizedModels(value.models);
  if (value.provider === "anthropic") {
    return {
      id: value.id,
      label,
      provider: "anthropic",
      baseUrl: "",
      models,
      requiresKey: true,
    };
  }

  if (typeof value.baseUrl !== "string" || value.baseUrl.length > 2048) return null;
  let endpoint: URL;
  try { endpoint = parseProviderUrl(value.baseUrl); } catch { return null; }
  return {
    id: value.id,
    label,
    provider: "openai",
    baseUrl: endpoint.toString(),
    models,
    // Local and hosted custom endpoints may be either keyed or keyless. Built-in
    // local presets default to keyless in the renderer, while built-in hosted
    // endpoints can never have their known authentication policy weakened.
    requiresKey: isKnownKeyedOpenAIEndpoint(endpoint.toString())
      ? true
      : booleanOr(value.requiresKey, isLoopbackHostname(endpoint.hostname) ? false : true),
  };
}

function normalizeVersionedAgentSettings(value: Record<string, unknown>): AgentSettings {
  const input = Array.isArray(value.connections) ? value.connections : [];
  const connections: AgentConnection[] = [];
  const ids = new Set<string>();
  for (const candidate of input) {
    const connection = normalizeAgentConnection(candidate);
    if (!connection || ids.has(connection.id)) continue;
    ids.add(connection.id);
    connections.push(connection);
    if (connections.length === MAX_AGENT_CONNECTIONS) break;
  }
  const requestedActive = isRecord(value.active) ? value.active : {};
  const requestedId = validConnectionId(requestedActive.connectionId) ? requestedActive.connectionId : "";
  const requestedConnection = connections.find((candidate) => candidate.id === requestedId);
  const requestedModel = normalizedModel(requestedActive.model);
  if (requestedConnection && requestedModel && !requestedConnection.models.includes(requestedModel)) {
    requestedConnection.models = [requestedModel, ...requestedConnection.models].slice(0, MAX_MODELS_PER_CONNECTION);
  }
  const usableConnections = connections.filter((connection) => connection.models.length > 0);
  if (usableConnections.length === 0) return defaultAgentSettings();
  const connection = usableConnections.find((candidate) => candidate.id === requestedId) ?? usableConnections[0];
  const useRequestedModel = connection.id === requestedId && requestedModel !== null &&
    connection.models.includes(requestedModel);
  const model = useRequestedModel ? requestedModel : connection.models[0];
  const credentialRevision = typeof value.credentialRevision === "number" &&
      Number.isInteger(value.credentialRevision) && value.credentialRevision >= 0 &&
      value.credentialRevision <= MAX_CREDENTIAL_REVISION
    ? value.credentialRevision
    : 0;
  return {
    schemaVersion: 1,
    connections: usableConnections,
    active: { connectionId: connection.id, model },
    credentialRevision,
  };
}

function hasLegacyAgentFields(raw: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(raw, "agentProvider") ||
    Object.prototype.hasOwnProperty.call(raw, "openaiBaseUrl") ||
    Object.prototype.hasOwnProperty.call(raw, "openaiModel");
}

/** Stable only for importing the single connection stored by older releases. */
export function legacyAgentConnectionId(provider: AgentProvider, baseUrl: string): string {
  const endpoint = provider === "anthropic" ? "anthropic" : parseProviderUrl(baseUrl).toString();
  const digest = createHash("sha256").update(`${provider}\0${endpoint}`).digest("hex").slice(0, 56);
  return `legacy-${digest}`;
}

function legacyAgentSettings(raw: Record<string, unknown>): AgentSettings {
  if (!hasLegacyAgentFields(raw)) return defaultAgentSettings();
  const provider: AgentProvider = raw.agentProvider === "anthropic" ? "anthropic" : "openai";
  if (provider === "anthropic") {
    const id = legacyAgentConnectionId("anthropic", "");
    const connection: AgentConnection = {
      id,
      label: "Anthropic",
      provider,
      baseUrl: "",
      models: [DEFAULT_ANTHROPIC_MODEL],
      requiresKey: true,
    };
    return {
      schemaVersion: 1,
      connections: [connection],
      active: { connectionId: id, model: DEFAULT_ANTHROPIC_MODEL },
      credentialRevision: 0,
    };
  }

  const baseUrl = providerUrlOr(raw.openaiBaseUrl, DEFAULT_GEMINI_BASE_URL);
  const model = normalizedModel(raw.openaiModel) ?? DEFAULT_GEMINI_MODEL;
  const id = legacyAgentConnectionId("openai", baseUrl);
  const endpoint = parseProviderUrl(baseUrl);
  const connection: AgentConnection = {
    id,
    label: endpoint.toString() === DEFAULT_GEMINI_BASE_URL ? "Google Gemini" : "Imported model provider",
    provider,
    baseUrl: endpoint.toString(),
    models: [model],
    // Older releases treated only their exact hosted presets as requiring a
    // key. Custom HTTPS and local endpoints could be genuinely keyless, while
    // still allowing a user to save an optional credential. Disk-aware legacy
    // loading below promotes this to keyed when such a credential exists.
    requiresKey: isKnownKeyedOpenAIEndpoint(endpoint.toString()),
  };
  return {
    schemaVersion: 1,
    connections: [connection],
    active: { connectionId: id, model },
    credentialRevision: 0,
  };
}

function agentSettings(raw: Record<string, unknown>): AgentSettings {
  return isRecord(raw.agent) && raw.agent.schemaVersion === 1
    ? normalizeVersionedAgentSettings(raw.agent)
    : legacyAgentSettings(raw);
}

/** A narrow runtime schema — TypeScript types do not validate IPC or disk data. */
export function normalizeConfig(value: unknown): StudioConfig {
  const raw = isRecord(value) ? value : {};
  // Migrate the original single client/server slots. A cfx-server.exe selection
  // unambiguously identifies Enhanced; older FXServer.exe settings are Legacy.
  const oldServerPath = nullablePath(raw.fxServerExePath);
  const inferredTarget: CfxTarget = oldServerPath?.toLowerCase().endsWith("cfx-server.exe") ? "enhanced" : "legacy";
  // v1.1.5 stored only a Legacy/Enhanced edition. Preserve it while moving to
  // the wider target model that also includes RedM.
  const migratedEdition = raw.activeCfxEdition === "legacy" || raw.activeCfxEdition === "enhanced" ? raw.activeCfxEdition : null;
  const activeCfxTarget: CfxTarget =
    raw.activeCfxTarget === "legacy" || raw.activeCfxTarget === "enhanced" || raw.activeCfxTarget === "redm"
      ? raw.activeCfxTarget
      : (migratedEdition ?? inferredTarget);
  const oldClientPath = nullablePath(raw.fivemExePath);
  return {
    txDataPath: nullablePath(raw.txDataPath),
    selectedProfile: safeProfile(raw.selectedProfile),
    theme: themePreferenceOrDefault(raw.theme),
    uiScale: uiScaleOrDefault(raw.uiScale),
    activeCfxTarget,
    legacyFivemExePath:
      nullablePath(raw.legacyFivemExePath) ?? (inferredTarget === "legacy" ? oldClientPath : null),
    enhancedFivemExePath:
      nullablePath(raw.enhancedFivemExePath) ?? (inferredTarget === "enhanced" ? oldClientPath : null),
    redmClientExePath: nullablePath(raw.redmClientExePath),
    legacyFxServerExePath:
      nullablePath(raw.legacyFxServerExePath) ?? (inferredTarget === "legacy" ? oldServerPath : null),
    enhancedFxServerExePath:
      nullablePath(raw.enhancedFxServerExePath) ?? (inferredTarget === "enhanced" ? oldServerPath : null),
    redmFxServerExePath: nullablePath(raw.redmFxServerExePath),
    legacyArtifactTrack:
      raw.legacyArtifactTrack === "latest" || raw.artifactTrack === "latest" ? "latest" : "recommended",
    redmArtifactTrack: raw.redmArtifactTrack === "latest" ? "latest" : "recommended",
    consoleRefreshIntervalMs: consoleRefreshIntervalOrDefault(raw.consoleRefreshIntervalMs),
    notifyOnServerExit: booleanOr(raw.notifyOnServerExit, DEFAULTS.notifyOnServerExit),
    discordPresenceEnabled: booleanOr(raw.discordPresenceEnabled, DEFAULTS.discordPresenceEnabled),
    agentSpendWarningUsd: spendWarningOrDefault(raw.agentSpendWarningUsd),
    editor: editorPreferences(raw.editor),
    agent: agentSettings(raw),
  };
}

// --- API keys ---
// Deliberately stored outside StudioConfig: that object is handed to the renderer
// on every config:get, and a credential has no business crossing into a browser
// context. These live main-process-only — the renderer can set one and ask whether
// it exists, but can never read it back.
//
// Encrypted at rest with Electron's safeStorage (DPAPI on Windows, Keychain on
// macOS, libsecret on Linux) rather than sitting in plaintext next to the config.

function credentialPath(name: string): string {
  return path.join(app.getPath("userData"), `${name}-key.bin`);
}

function credentialCandidates(name: string): string[] {
  const directories = [app.getPath("userData"), ...previousProductUserDataPaths()];
  return [...new Set(directories.map((directory) => path.join(directory, `${name}-key.bin`)))];
}

/** Keep the identity-free compatibility filenames tied to the config document
 * that proves who owns them. In particular, never search a colliding legacy
 * URL slug in another product directory. */
export function legacyCredentialStoragePaths(
  connection: AgentConnection,
  persistedConfigPath: string,
  safeHistoricalDirectories: readonly string[] = [],
): string[] {
  const directory = path.dirname(persistedConfigPath);
  if (connection.provider === "anthropic") {
    // Anthropic's former filename is provider-specific rather than derived
    // from a user-controlled endpoint, so it cannot suffer the truncated-slug
    // collision below. Keep searching QB Studio's explicitly known former
    // product directories so upgrades from the flat settings schema do not
    // strand an otherwise valid saved key.
    return [...new Set([
      path.join(directory, "anthropic-key.bin"),
      ...safeHistoricalDirectories.map((candidate) => path.join(candidate, "anthropic-key.bin")),
    ])];
  }
  const names = providerCredentialStorageNames(connection.baseUrl);
  // The complete endpoint hash is safe to recover from former product
  // directories. The truncated identity-free slug is not: only the directory
  // containing the winning raw config can establish ownership of that alias.
  return [...new Set([
    path.join(directory, `${names.current}-key.bin`),
    path.join(directory, `${names.legacy}-key.bin`),
    ...safeHistoricalDirectories.map((candidate) => path.join(candidate, `${names.current}-key.bin`)),
  ])];
}

function persistedLegacyCredentialPaths(connection: AgentConnection, persistedConfigPath: string): string[] {
  return legacyCredentialStoragePaths(
    connection,
    persistedConfigPath,
    [app.getPath("userData"), ...previousProductUserDataPaths()],
  );
}

/** Preserve the effective authentication behavior of the flat pre-v1 schema.
 * Exact hosted presets required a key. Custom hosted and loopback endpoints
 * were keyless unless the user had actually saved a credential, in which case
 * the provider sent it on every request. Existence is intentionally enough:
 * a corrupt credential must remain visible for repair rather than being
 * silently reclassified as keyless and deleted by the next Settings save. */
function normalizePersistedConfig(persisted: PersistedConfigDocument | null): StudioConfig {
  const normalized = normalizeConfig(persisted?.raw ?? {});
  if (!persisted || !isRecord(persisted.raw) || !hasLegacyAgentFields(persisted.raw) ||
      (isRecord(persisted.raw.agent) && persisted.raw.agent.schemaVersion === 1)) {
    return normalized;
  }
  const connection = normalized.agent.connections[0];
  if (!connection || connection.provider !== "openai" || connection.requiresKey) return normalized;
  const credentialExists = [
    ...persistedLegacyCredentialPaths(connection, persisted.path),
    ...credentialCandidates(connectionCredentialStorageName(connection)),
  ].some((candidate) => fs.existsSync(candidate));
  if (!credentialExists) return normalized;
  const keyedConnection = { ...connection, requiresKey: true };
  return {
    ...normalized,
    agent: {
      ...normalized.agent,
      connections: [keyedConnection, ...normalized.agent.connections.slice(1)],
    },
  };
}

export interface CredentialLoadPlan {
  candidates: string[];
  retireAfterMigration: string[];
}

function credentialPathIdentity(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function uniqueCredentialPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    const identity = credentialPathIdentity(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Decide credential precedence before decrypting anything.
 *
 * A compatibility filename owned by the winning flat config is authoritative
 * over a possibly stale scoped destination. Otherwise, an existing current
 * scoped file is authoritative even when corrupt: falling through to an old
 * product directory could silently resurrect a superseded account key.
 * Historical scoped copies are considered only while the current target is
 * absent, and every one of them is retired after a successful migration.
 *
 * @internal Exported for regression tests of the storage plan.
 */
export function credentialLoadPlan(
  currentPath: string,
  scopedCandidates: readonly string[],
  authoritativeLegacyPaths: readonly string[],
  exists: (candidate: string) => boolean = fs.existsSync,
): CredentialLoadPlan {
  const currentIdentity = credentialPathIdentity(currentPath);
  const legacy = uniqueCredentialPaths(authoritativeLegacyPaths)
    .filter((candidate) => credentialPathIdentity(candidate) !== currentIdentity);
  const ownedExisting = legacy.filter(exists);
  if (ownedExisting.length > 0) {
    return { candidates: ownedExisting, retireAfterMigration: legacy };
  }
  if (exists(currentPath)) {
    return { candidates: [currentPath], retireAfterMigration: [] };
  }
  const historical = uniqueCredentialPaths(scopedCandidates)
    .filter((candidate) => credentialPathIdentity(candidate) !== currentIdentity);
  return { candidates: historical, retireAfterMigration: historical };
}

/** Authentication identity deliberately excludes label, model, and readiness
 * policy. It includes both the connection id (separate accounts at one
 * endpoint) and canonical endpoint (editing a connection can never send its
 * old key to a new host). Keyless connections are prevented from loading this
 * credential at all and transitions to keyless retire the same scoped file. */
export function connectionCredentialScope(connection: AgentConnection): string {
  if (!validConnectionId(connection.id)) throw new Error("Agent connection id is invalid.");
  if (connection.provider === "anthropic") return `${connection.id}\0anthropic\0anthropic`;
  if (connection.provider !== "openai") throw new Error("Agent connection provider is invalid.");
  const endpoint = parseProviderUrl(connection.baseUrl).toString();
  return `${connection.id}\0openai\0${endpoint}`;
}

export function connectionCredentialStorageName(connection: AgentConnection): string {
  return `agent-connection-${createHash("sha256").update(connectionCredentialScope(connection)).digest("hex")}`;
}

/** Old endpoint-scoped names remain exported only for deterministic migration
 * tests and compatibility reads. New callers must address a configured id. */
function legacyEndpointSlug(baseUrl: string): string {
  const cleaned = baseUrl.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
  return `provider-${cleaned.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80) || "unset"}`;
}

export function providerCredentialStorageNames(baseUrl: string): { current: string; legacy: string } {
  const canonical = parseProviderUrl(baseUrl).toString();
  return {
    current: `provider-${createHash("sha256").update(canonical).digest("hex")}`,
    legacy: legacyEndpointSlug(canonical),
  };
}

export function providerCredentialStorageAccess(
  requestedBaseUrl: string,
  persistedBaseUrl: string,
): { current: string; legacy: string | null } {
  const requested = providerCredentialStorageNames(requestedBaseUrl);
  const persisted = providerCredentialStorageNames(persistedBaseUrl);
  return {
    current: requested.current,
    legacy: requested.current === persisted.current ? requested.legacy : null,
  };
}

function removeCredentialPaths(paths: string[]): void {
  const failures: unknown[] = [];
  for (const candidate of [...new Set(paths)]) {
    try { fs.rmSync(candidate, { force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    throw new Error("The encrypted credential could not be removed from disk. Close other QB Studio instances and try again.");
  }
}

function writeEncryptedCredential(name: string, value: string): void {
  const target = credentialPath(name);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporary, encryptCredential(value), { flag: "wx", mode: 0o600 });
    const handle = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

function encryptCredential(value: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure OS credential storage is unavailable; refusing to save this credential in plaintext.");
  }
  return safeStorage.encryptString(value);
}

interface ReadCredentialResult {
  value: string;
  wasPlaintext: boolean;
}

function readCredentialFile(filePath: string): ReadCredentialResult {
  const raw = fs.readFileSync(filePath);
  const asText = raw.toString("utf8");
  // Early development builds used a marked plaintext fallback. Never expose it
  // unless secure storage is now available to re-encrypt it immediately.
  if (asText.startsWith("plain:")) {
    return {
      value: safeStorage.isEncryptionAvailable() ? asText.slice("plain:".length) : "",
      wasPlaintext: true,
    };
  }
  return { value: safeStorage.decryptString(raw), wasPlaintext: false };
}

function loadCredential(name: string, authoritativeLegacyPaths: string[] = []): string {
  const current = credentialPath(name);
  const plan = credentialLoadPlan(current, credentialCandidates(name), authoritativeLegacyPaths);
  for (const candidate of plan.candidates) {
    let credential: ReadCredentialResult;
    try {
      credential = readCredentialFile(candidate);
    } catch {
      // Try the remaining candidates within the selected authority class.
      continue;
    }
    const { value } = credential;
    if (!value) continue;
    if (candidate !== current || credential.wasPlaintext) {
      writeEncryptedCredential(name, value);
    }
    if (candidate !== current) {
      // Deliberately outside the tolerant read block: a failed retirement must
      // stay visible instead of silently resurrecting a compatibility key.
      removeCredentialPaths(plan.retireAfterMigration);
    }
    return value;
  }
  return "";
}

function requireConfiguredConnection(connectionId: string): AgentConnection {
  if (!validConnectionId(connectionId)) throw new Error("Agent connection id is invalid.");
  const connection = loadConfig().agent.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) throw new Error("That agent connection is not configured.");
  return connection;
}

interface PersistedLegacyConnection {
  credentialPaths: string[];
}

function persistedLegacyConnectionFor(connection: AgentConnection): PersistedLegacyConnection | null {
  let persisted: PersistedConfigDocument | null;
  try { persisted = readPersistedConfig(); } catch { return null; }
  if (!persisted || !isRecord(persisted.raw) || !hasLegacyAgentFields(persisted.raw)) return null;
  if (isRecord(persisted.raw.agent) && persisted.raw.agent.schemaVersion === 1) return null;
  const legacy = legacyAgentSettings(persisted.raw).connections[0];
  return legacy.id === connection.id && connectionCredentialScope(legacy) === connectionCredentialScope(connection)
    ? { credentialPaths: persistedLegacyCredentialPaths(legacy, persisted.path) }
    : null;
}

function legacyCredentialNames(connection: AgentConnection): string[] {
  if (connection.provider === "anthropic") return ["anthropic"];
  const names = providerCredentialStorageNames(connection.baseUrl);
  return [names.current, names.legacy];
}

export function loadConnectionKey(connectionId: string): string {
  const connection = requireConfiguredConnection(connectionId);
  if (!connection.requiresKey) return "";
  const legacy = persistedLegacyConnectionFor(connection);
  return loadCredential(
    connectionCredentialStorageName(connection),
    legacy ? legacy.credentialPaths : [],
  );
}

export function hasConnectionKey(connectionId: string): boolean {
  return loadConnectionKey(connectionId).length > 0;
}

interface LegacyCredentialMigrationPlan {
  write: { path: string; data: Buffer } | null;
  removals: string[];
}

/** Plan migration while the raw config still proves ownership of its legacy
 * aliases. The authoritative old source is encrypted for the scoped target
 * before the filesystem transaction mutates anything. */
function prepareLegacyCredentialMigration(
  persisted: PersistedConfigDocument,
  previousConnections: AgentConnection[],
  nextConnections: AgentConnection[],
  explicitlyUpdatedIds: ReadonlySet<string>,
): LegacyCredentialMigrationPlan {
  const empty = (): LegacyCredentialMigrationPlan => ({ write: null, removals: [] });
  if (!isRecord(persisted.raw) || !hasLegacyAgentFields(persisted.raw)) return empty();
  if (isRecord(persisted.raw.agent) && persisted.raw.agent.schemaVersion === 1) return empty();
  const legacy = legacyAgentSettings(persisted.raw).connections[0];
  const configured = previousConnections.find((connection) =>
    connection.id === legacy.id && connectionCredentialScope(connection) === connectionCredentialScope(legacy));
  if (!configured) return empty();

  const targetName = connectionCredentialStorageName(configured);
  const target = credentialPath(targetName);
  const sourcePaths = persistedLegacyCredentialPaths(legacy, persisted.path)
    .filter((candidate, index, all) => candidate !== target && all.indexOf(candidate) === index && fs.existsSync(candidate));
  if (sourcePaths.length === 0) return empty();

  const next = nextConnections.find((connection) =>
    connection.id === configured.id &&
    connection.requiresKey &&
    connectionCredentialScope(connection) === connectionCredentialScope(configured));
  // Endpoint removal/change, a transition to keyless, or an explicit key
  // replacement/clear retires the owned legacy aliases without inheriting them.
  if (!next || explicitlyUpdatedIds.has(configured.id)) {
    return { write: null, removals: sourcePaths };
  }

  // The raw config and its colocated credential are the authoritative legacy
  // pair. They intentionally win over an already-present scoped destination,
  // which may be stale residue from an interrupted or rolled-back migration.
  let preserved = "";
  for (const source of sourcePaths) {
    try {
      preserved = readCredentialFile(source).value;
      if (preserved) break;
    } catch { /* try another compatibility name in the owning directory */ }
  }
  if (!preserved) {
    throw new Error("The existing model-provider key could not be decrypted, so its configuration was not migrated.");
  }
  return {
    write: { path: target, data: encryptCredential(preserved) },
    removals: sourcePaths,
  };
}

function requestedAgentConnectionIds(requestedConfig: unknown): Set<string> | null {
  if (!isRecord(requestedConfig) || !isRecord(requestedConfig.agent) ||
      requestedConfig.agent.schemaVersion !== 1 || !Array.isArray(requestedConfig.agent.connections)) return null;
  // Presence of a syntactically valid id distinguishes an explicit removal
  // from a connection that normalization rejected due to another bad field.
  return new Set(
    requestedConfig.agent.connections
      .filter(isRecord)
      .map((connection) => connection.id)
      .filter(validConnectionId),
  );
}

function fileIdentity(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function credentialConnectionIdentity(connection: AgentConnection): CredentialConnectionIdentity {
  return {
    id: connection.id,
    scope: connectionCredentialScope(connection),
    storageName: connectionCredentialStorageName(connection),
    requiresKey: connection.requiresKey,
  };
}

/**
 * Atomically save public settings and zero or more write-only credentials.
 * Every encrypted write and retirement is completed before the public config
 * becomes visible; any pre-commit failure restores the old credential files.
 */
export function saveConfigWithConnectionKeys(
  config: unknown,
  keyUpdates: readonly ConnectionKeyUpdate[],
): StudioConfig {
  if (!Array.isArray(keyUpdates) || keyUpdates.length > MAX_AGENT_CONNECTIONS) {
    throw new Error(`Save no more than ${MAX_AGENT_CONNECTIONS} agent credential changes at once.`);
  }
  const normalized = normalizeConfig(config);
  const connections = new Map(normalized.agent.connections.map((connection) => [connection.id, connection]));
  const seen = new Set<string>();
  const updates = keyUpdates.map((candidate) => {
    if (!candidate || !validConnectionId(candidate.connectionId) || typeof candidate.key !== "string" ||
        candidate.key.length > 4096 || candidate.key !== candidate.key.trim() || CONTROL_CHARACTER.test(candidate.key)) {
      throw new Error("An agent credential change is invalid.");
    }
    if (seen.has(candidate.connectionId)) {
      throw new Error("Each agent connection can have only one credential change per save.");
    }
    seen.add(candidate.connectionId);
    const connection = connections.get(candidate.connectionId);
    if (!connection) throw new Error("A credential change targets an agent connection that is not being saved.");
    if (!connection.requiresKey && candidate.key) {
      throw new Error(`Agent connection “${connection.label}” is keyless and cannot store or send an API key.`);
    }
    return { connection, key: candidate.key };
  });

  let persisted: PersistedConfigDocument | null = null;
  try { persisted = readPersistedConfig(); } catch { /* loadConfig's tolerant behavior */ }
  const previous = normalizePersistedConfig(persisted);
  const migration = persisted
    ? prepareLegacyCredentialMigration(persisted, previous.agent.connections, normalized.agent.connections, seen)
    : { write: null, removals: [] };

  const mutationPlan = buildCredentialMutationPlan({
    requestedConnectionIds: requestedAgentConnectionIds(config),
    previousConnections: previous.agent.connections.map(credentialConnectionIdentity),
    nextConnections: normalized.agent.connections.map(credentialConnectionIdentity),
    updates: updates.map(({ connection, key }) => ({
      connectionId: connection.id,
      data: key ? encryptCredential(key) : null,
    })),
    migration,
    currentPath: credentialPath,
    candidates: credentialCandidates,
    pathIdentity: fileIdentity,
  });

  const transaction = new NativeFileTransaction();
  for (const write of mutationPlan.writes) transaction.stageWrite(write.path, write.data, { mode: 0o600 });
  for (const removal of mutationPlan.removals) transaction.stageRemoval(removal);
  transaction.commit(configPath(), JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return normalized;
}
