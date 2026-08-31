import { useEffect, useState, useCallback, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import TopBar from "./components/TopBar";
import SettingsModal from "./components/SettingsModal";
import ResourceTree from "./components/ResourceTree";
import SearchPanel from "./components/SearchPanel";
import GithubImportPanel from "./components/GithubImportPanel";
import CenterPane, { type CenterTab } from "./components/CenterPane";
import ChatPanel from "./components/ChatPanel";
import StatusArea, { type StatusItem } from "./components/StatusArea";
import WhatsNewPanel from "./components/WhatsNewPanel";
import BookmarksPanel from "./components/BookmarksPanel";
import { t } from "./i18n";
import { lastConsoleLines } from "./consoleText";
import { activateTheme } from "./theme";
import { PerPathSaveQueue, reconcileSuccessfulSave } from "../electron/editorSaveReconciliation";
import {
  agentPromptAgentScope,
  agentPromptWorkspaceScope,
  consumeAgentPromptEnvelope,
  type AgentPromptEnvelope,
  type AgentPromptMode,
} from "../electron/agentPromptDecision";
import type {
  AgentCredentialUpdate,
  AgentTarget,
  AppUpdateState,
  CfxTarget,
  CrashTriageContext,
  FileSnapshot,
  EditorProblem,
  EditorBookmark,
  ResolvedProfile,
  ResolvedTheme,
  RecentWorkspaceSummary,
  ResourceContext,
  ResourceDependencyGraph,
  ResourceStatusResult,
  RuntimeIdentity,
  RuntimeWorkspaceMatch,
  StudioConfig,
  ThemePack,
  ThemePreference,
  WhatsNewState,
} from "./global";

export interface OpenFile {
  path: string;
  content: string;
  revision: string;
  dirty: boolean;
}

export interface FileChangeReview {
  id: number;
  path: string;
  kind: "agent" | "conflict";
  originalContent: string;
  modifiedContent: string;
  originalLabel: string;
  modifiedLabel: string;
  diskRevision: string;
}

type SidebarTab = "resources" | "search" | "bookmarks" | "github";
type DiscordActivityView = "startup" | "viewport" | "console" | "resources" | "editor" | "review" | "assistant" | "setup" | "settings";

const DEFAULT_CONFIG: StudioConfig = {
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
  agent: {
    schemaVersion: 1,
    connections: [{
      id: "google-gemini-default",
      label: "Google Gemini",
      provider: "openai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      models: ["gemini-3.7-flash"],
      requiresKey: true,
    }],
    active: { connectionId: "google-gemini-default", model: "gemini-3.7-flash" },
    credentialRevision: 0,
  },
};

const EMPTY_PROFILE: ResolvedProfile = { profileRoot: "", resourcesPath: null, serverCfgPath: null };
const LOADING_APP_UPDATE_STATE: AppUpdateState = {
  phase: "disabled",
  currentVersion: "…",
  latestVersion: null,
  releaseUrl: null,
  progressPercent: null,
  transferredBytes: null,
  totalBytes: null,
  error: null,
};

function cfxTargetLabel(target: CfxTarget): string {
  if (target === "legacy") return "FiveM Legacy";
  if (target === "enhanced") return "FiveM Enhanced";
  return "RedM";
}

function serverExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFxServerExePath;
  if (target === "enhanced") return config.enhancedFxServerExePath;
  return config.redmFxServerExePath;
}

function clientExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFivemExePath;
  if (target === "enhanced") return config.enhancedFivemExePath;
  return config.redmClientExePath;
}

export default function App() {
  const [config, setConfig] = useState<StudioConfig>(DEFAULT_CONFIG);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");
  const [themePacks, setThemePacks] = useState<ThemePack[]>([]);
  const [themePreview, setThemePreview] = useState<ThemePreference | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<"top" | "agent">("top");
  const [connected, setConnected] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceSummary[]>([]);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [runtimeIdentity, setRuntimeIdentity] = useState<RuntimeIdentity | null>(null);
  const [workspaceMatch, setWorkspaceMatch] = useState<RuntimeWorkspaceMatch | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverAction, setServerAction] = useState<"starting" | "stopping" | "restarting" | null>(null);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverPids, setServerPids] = useState<number[]>([]);
  const [serverTarget, setServerTarget] = useState<CfxTarget>("legacy");
  const [serverStartedAt, setServerStartedAt] = useState<number | null>(null);
  const [serverStatusError, setServerStatusError] = useState<string | null>(null);
  const [serverNotice, setServerNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const [whatsNew, setWhatsNew] = useState<WhatsNewState | null>(null);
  const serverStatusEpoch = useRef(0);
  const observedServerRunning = useRef<boolean | null>(null);
  const serverLaunchedInIdentity = useRef(false);
  const intentionalServerStop = useRef(false);
  const latestConsoleOutput = useRef("");
  const [crashTriage, setCrashTriage] = useState<CrashTriageContext | null>(null);
  const currentAgentPromptScope = agentPromptWorkspaceScope(config.txDataPath, config.selectedProfile);
  const currentAgentConnection = config.agent.connections.find(
    (connection) => connection.id === config.agent.active.connectionId,
  ) ?? config.agent.connections[0];
  const currentAgentTargetScope = agentPromptAgentScope(
    config.agent.active.connectionId,
    config.agent.active.model,
    currentAgentConnection?.provider,
    currentAgentConnection?.baseUrl,
    config.agent.credentialRevision,
    currentAgentConnection?.requiresKey ?? null,
  );
  const agentPromptScopeRef = useRef(currentAgentPromptScope);
  const agentTargetScopeRef = useRef(currentAgentTargetScope);
  agentPromptScopeRef.current = currentAgentPromptScope;
  agentTargetScopeRef.current = currentAgentTargetScope;
  const agentPromptSequence = useRef(0);
  const [agentPrompt, setAgentPrompt] = useState<AgentPromptEnvelope | null>(null);
  const [assistantActive, setAssistantActive] = useState(false);

  const offerAgentPrompt = useCallback((
    text: string,
    mode: AgentPromptMode,
    workspaceScope = agentPromptScopeRef.current,
    agentScope = agentTargetScopeRef.current,
  ) => {
    setAgentPrompt({
      id: ++agentPromptSequence.current,
      text,
      mode,
      workspaceScope,
      agentScope,
    });
  }, []);
  const consumeAgentPrompt = useCallback((id: number) => {
    setAgentPrompt((current) => consumeAgentPromptEnvelope(current, id));
  }, []);

  useEffect(() => {
    // Workspace changes invalidate prepared code context entirely. Agent
    // changes are handled in ChatPanel, which safely downgrades an automatic
    // submission to an unsent draft rather than leaking it across providers.
    setAgentPrompt((current) => current?.workspaceScope === currentAgentPromptScope ? current : null);
  }, [currentAgentPromptScope]);

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("resources");
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [resourceDropActive, setResourceDropActive] = useState(false);
  const [resourceDropImporting, setResourceDropImporting] = useState(false);
  const resourceDragDepth = useRef(0);
  const [resourceStatuses, setResourceStatuses] = useState<ResourceStatusResult>({
    resources: [],
    serverStateAvailable: false,
  });
  const [dependencyGraph, setDependencyGraph] = useState<ResourceDependencyGraph>({ nodes: [] });
  const [bookmarks, setBookmarks] = useState<EditorBookmark[]>([]);
  const [resourceAction, setResourceAction] = useState<string | null>(null);
  const [resourceNotice, setResourceNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [activeResourceContext, setActiveResourceContext] = useState<ResourceContext | null>(null);
  const [consoleRefreshSignal, setConsoleRefreshSignal] = useState<{ resource: string; nonce: number } | null>(null);
  const resourceStatusRequest = useRef<{ scope: string; promise: Promise<void> } | null>(null);
  const resourceStatusSequence = useRef(0);

  const [resolved, setResolved] = useState<ResolvedProfile>(EMPTY_PROFILE);

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const openFilesRef = useRef<OpenFile[]>([]);
  const saveQueueRef = useRef(new PerPathSaveQueue());
  const fileRefreshGeneration = useRef(new Map<string, number>());
  const pendingOpensRef = useRef(new Map<string, Promise<boolean>>());
  const openGenerationRef = useRef(0);
  const updateOpenFiles = useCallback((update: OpenFile[] | ((current: OpenFile[]) => OpenFile[])) => {
    const next = typeof update === "function" ? update(openFilesRef.current) : update;
    openFilesRef.current = next;
    setOpenFiles(next);
  }, []);
  const [activePath, setActivePath] = useState<string | null>(null);
  const recentFilePaths = useRef<string[]>([]);
  const ctrlTabSession = useRef<{ order: string[]; index: number } | null>(null);
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = activePath;
  // Viewport, not editor: with no files open yet, defaulting to "editor" leaves the
  // tab strip with nothing highlighted and an empty pane, which reads as a broken state.
  const [centerTab, setCenterTab] = useState<CenterTab>("viewport");
  const [clientAutoAttachRequest, setClientAutoAttachRequest] = useState<{
    target: CfxTarget;
    launchPid: number | null;
    nonce: number;
  } | null>(null);
  const [selection, setSelection] = useState<{ path: string | null; selectedText: string; startLine: number; endLine: number }>({
    path: null,
    selectedText: "",
    startLine: 0,
    endLine: 0,
  });
  const [editorProblems, setEditorProblems] = useState<Record<string, EditorProblem[]>>({});
  const [editorReveal, setEditorReveal] = useState<{ path: string; line: number; column: number; nonce: number } | null>(null);
  const openEditorLocationRef = useRef<(path: string, line: number, column: number) => Promise<void>>(async () => undefined);
  const [changeReviews, setChangeReviews] = useState<Record<string, FileChangeReview>>({});
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const reviewNonce = useRef(0);
  const activeServerPath = serverExeFor(config, config.activeCfxTarget);
  const activeClientPath = clientExeFor(config, config.activeCfxTarget);
  const activeTargetLabel = cfxTargetLabel(config.activeCfxTarget);
  const runtimeReadable = connected && workspaceMatch?.ok === true;
  const runtimeWritable = runtimeReadable && runtimeIdentity?.capabilities.resourceLifecycle === true;
  const resourceStates = Object.fromEntries(
    resourceStatuses.resources.map((resource) => [resource.name.toLowerCase(), resource.state]),
  ) as Record<string, "started" | "stopped">;
  const resourceStatusScope = [
    connected ? "connected" : "disconnected",
    config.txDataPath ?? "",
    config.selectedProfile ?? "",
    runtimeIdentity?.runtime.serverData.workspacePath ?? "",
  ].join("|");
  const resourceStatusScopeRef = useRef(resourceStatusScope);
  resourceStatusScopeRef.current = resourceStatusScope;

  const connect = useCallback(async () => {
    try {
      const result = await window.api.mcp.connect();
      setConnected(result.ok);
      setRuntimeIdentity(result.runtimeIdentity ?? null);
      setWorkspaceMatch(result.workspaceMatch ?? null);
      // Keep the previous warning mounted during background retries. Clearing
      // it before every attempt made the entire workspace jump every three
      // seconds; a successful connection is the only truthful clear signal.
      setConnectError(result.ok ? null : (result.error ?? "Could not connect"));
      return result.ok;
    } catch (err) {
      setConnected(false);
      setRuntimeIdentity(null);
      setWorkspaceMatch(null);
      setConnectError((err as Error).message || "Could not connect");
      return false;
    }
  }, []);

  const refreshResourceStatuses = useCallback((force = false): Promise<void> => {
    if (!connected || workspaceMatch?.ok !== true) return Promise.resolve();
    const existing = resourceStatusRequest.current;
    if (!force && existing?.scope === resourceStatusScope) return existing.promise;

    const sequence = ++resourceStatusSequence.current;
    const request = window.api.resources.listStatuses()
      .then((status) => {
        if (resourceStatusScopeRef.current === resourceStatusScope && resourceStatusSequence.current === sequence) {
          setResourceStatuses(status);
        }
      })
      .catch(() => {
        // Connection state owns the visible failure. Status polling stays quiet
        // while the runtime is starting or the local server is temporarily down.
      })
      .finally(() => {
        if (resourceStatusRequest.current?.promise === request) resourceStatusRequest.current = null;
      });
    resourceStatusRequest.current = { scope: resourceStatusScope, promise: request };
    return request;
  }, [connected, resourceStatusScope, workspaceMatch?.ok]);

  // Load saved config, then try connecting automatically.
  useEffect(() => {
    void window.api.config
      .get()
      .then((saved) => {
        setConfig(saved);
        setConfigLoaded(true);
        void window.api.recents.list().then(setRecentWorkspaces).catch(() => setRecentWorkspaces([]));
        void window.api.artifacts.recoveryNotice().then((notice) => notice && setArtifactNotice(notice));
        if (saved.txDataPath && saved.selectedProfile) {
          void connect();
        } else {
          setSettingsOpen(true);
        }
      })
      .catch((err) => {
        setConfigLoaded(true);
        setConnectError(`Could not load settings: ${(err as Error).message}`);
      });
  }, [connect]);

  // Main-process-only changes such as write-only credential updates increment
  // the public agent revision without exposing the key. Keep readiness and the
  // chat selector in sync with those broadcasts as well as ordinary Settings saves.
  useEffect(() => window.api.config.onChanged((saved) => {
    setConfig(saved);
  }), []);

  useEffect(() => window.api.console.onRefreshIntervalChanged((consoleRefreshIntervalMs) => {
    setConfig((current) => ({ ...current, consoleRefreshIntervalMs }));
  }), []);

  useEffect(() => window.api.console.onRevealSourceLocation((location) => {
    void openEditorLocationRef.current(location.path, location.line, location.column);
  }), []);

  useEffect(() => window.api.console.onAgentFixPrompt((prompt, workspaceScope, agentScope) => {
    offerAgentPrompt(prompt, "submit", workspaceScope, agentScope);
  }), [offerAgentPrompt]);

  const reloadThemePacks = useCallback(async () => {
    const packs = await window.api.theme.listPacks();
    setThemePacks(packs);
    return packs;
  }, []);

  useEffect(() => {
    void reloadThemePacks().catch(() => setThemePacks([]));
  }, [reloadThemePacks]);

  useEffect(() => {
    let cancelled = false;
    const preference = themePreview ?? config.theme;
    const applySystemTheme = (theme: "dark" | "light") => {
      if (!cancelled && preference === "system") setResolvedTheme(activateTheme(theme, themePacks));
    };
    if (preference === "system") {
      void window.api.theme.system().then(applySystemTheme).catch(() => applySystemTheme("dark"));
    } else {
      setResolvedTheme(activateTheme(preference, themePacks));
    }
    const unsubscribe = window.api.theme.onSystemChanged(applySystemTheme);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [config.theme, themePacks, themePreview]);

  const openSettings = useCallback(() => {
    setThemePreview(null);
    setSettingsInitialSection("top");
    setSettingsOpen(true);
  }, []);

  const openAgentSettings = useCallback(() => {
    setThemePreview(null);
    setSettingsInitialSection("agent");
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setThemePreview(null);
    setSettingsOpen(false);
    void window.api.theme.clearPreview();
  }, []);

  const previewTheme = useCallback((preference: ThemePreference) => {
    setThemePreview(preference);
    void window.api.theme.preview(preference);
  }, []);

  // Subscribe before fetching the snapshot so a fast provider event cannot be
  // lost between initialization and the first renderer paint. Startup failures
  // stay quiet; explicit checks and downloads surface their errors in state.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.api.app.onUpdateState((state) => {
      if (!cancelled) setAppUpdateState(state);
    });
    void window.api.app.getUpdateState()
      .then((state) => {
        if (!cancelled) setAppUpdateState(state);
        return window.api.app.checkForUpdate(false);
      })
      .then((state) => {
        if (!cancelled) setAppUpdateState(state);
      })
      .catch(() => {
        // Offline and rate-limited starts must remain quiet and usable.
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const runAppUpdateAction = useCallback(async (action: () => Promise<AppUpdateState>) => {
    setAppUpdateBusy(true);
    try {
      const state = await action();
      setAppUpdateState(state);
    } catch (error) {
      const message = (error as Error).message || "QB Studio couldn't complete the update.";
      setAppUpdateState((current) => current ? { ...current, phase: "error", error: message } : current);
      throw error;
    } finally {
      setAppUpdateBusy(false);
    }
  }, []);

  const checkForAppUpdate = useCallback(
    () => runAppUpdateAction(() => window.api.app.checkForUpdate(true)),
    [runAppUpdateAction],
  );
  const downloadAppUpdate = useCallback(
    () => runAppUpdateAction(() => window.api.app.downloadUpdate()),
    [runAppUpdateAction],
  );
  const restartToAppUpdate = useCallback(
    () => runAppUpdateAction(() => window.api.app.restartToUpdate()),
    [runAppUpdateAction],
  );

  useEffect(() => {
    void window.api.app.consumeWhatsNew().then(setWhatsNew).catch(() => setWhatsNew(null));
  }, []);

  const refreshServerStatus = useCallback(async (
    expectedEpoch = serverStatusEpoch.current,
    shouldApply: () => boolean = () => true,
  ) => {
    const isCurrent = () => shouldApply() && expectedEpoch === serverStatusEpoch.current;
    if (!config.legacyFxServerExePath && !config.enhancedFxServerExePath && !config.redmFxServerExePath) {
      if (!isCurrent()) return;
      setServerRunning(false);
      setServerPids([]);
      setServerTarget(config.activeCfxTarget);
      setServerStatusError(null);
      return;
    }
    try {
      const status = await window.api.server.status();
      if (!isCurrent()) return;
      const wasRunning = observedServerRunning.current;
      observedServerRunning.current = status.running;
      if (status.running && wasRunning !== true) setServerStartedAt(Date.now());
      if (!status.running) setServerStartedAt(null);
      if (wasRunning === true && !status.running) {
        const wasIntentional = intentionalServerStop.current;
        const wasStudioLaunched = serverLaunchedInIdentity.current;
        intentionalServerStop.current = false;
        serverLaunchedInIdentity.current = false;
        if (!wasIntentional && wasStudioLaunched) {
          const cachedTail = lastConsoleLines(latestConsoleOutput.current, 50);
          void Promise.all([
            window.api.mcp.callTool("get_console_output", { lines: 50 })
              .then((output) => lastConsoleLines(output, 50))
              .catch(() => cachedTail),
            window.api.server.crashReport().catch(() => null),
          ]).then(([consoleTail, report]) => {
            if (isCurrent()) setCrashTriage({ report, consoleTail, detectedAt: new Date().toISOString() });
          });
          void window.api.server.notifyUnexpectedExit(status.target).catch(() => {
            // Desktop notifications are advisory; the in-app crash context remains available.
          });
          setServerNotice({ message: `${cfxTargetLabel(status.target)} FXServer stopped unexpectedly. Review the crash context in Console.`, error: true });
        }
      }
      setServerRunning(status.running);
      setServerPids(status.pids);
      setServerTarget(status.target);
      setServerStatusError(null);
    } catch (err) {
      if (!isCurrent()) return;
      setServerStatusError((err as Error).message || "Server status is unavailable.");
    }
  }, [config.activeCfxTarget, config.legacyFxServerExePath, config.enhancedFxServerExePath, config.redmFxServerExePath]);

  // A running observation belongs to one configured executable/workspace. Do
  // not interpret the first stopped result after switching targets as a crash.
  useEffect(() => {
    serverStatusEpoch.current += 1;
    observedServerRunning.current = null;
    serverLaunchedInIdentity.current = false;
    intentionalServerStop.current = false;
    latestConsoleOutput.current = "";
    setCrashTriage(null);
    setServerNotice(null);
    setServerStartedAt(null);
  }, [
    config.activeCfxTarget,
    config.legacyFxServerExePath,
    config.enhancedFxServerExePath,
    config.redmFxServerExePath,
    config.txDataPath,
    config.selectedProfile,
  ]);

  // FXServer runs in the background. Poll the exact configured executable so
  // the top-bar control remains truthful after a restart or a stop initiated
  // in txAdmin.
  useEffect(() => {
    if (!configLoaded) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const expectedEpoch = serverStatusEpoch.current;
      await refreshServerStatus(expectedEpoch, () => !cancelled);
      if (!cancelled) timer = setTimeout(poll, 5_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [configLoaded, refreshServerStatus]);

  // The server is often started after Studio, so a failed connect can't be
  // terminal — keep retrying quietly in the background until it comes up.
  useEffect(() => {
    if (!configLoaded || connected || !config.txDataPath || !config.selectedProfile) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = async () => {
      if (cancelled) return;
      const ok = await connect();
      if (!cancelled && !ok) timer = setTimeout(retry, 3000);
    };
    timer = setTimeout(retry, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [configLoaded, config.txDataPath, config.selectedProfile, connected, connect]);

  // If the transport drops (server stopped), flip back to disconnected — which
  // re-arms the retry loop above.
  useEffect(() => {
    return window.api.mcp.onDropped(() => {
      setConnected(false);
      setRuntimeIdentity(null);
      setWorkspaceMatch(null);
      setResourceStatuses({ resources: [], serverStateAvailable: false });
      setConnectError("Lost connection to the bundled coding runtime.");
    });
  }, []);

  // Resource state is shared by the tree and editor controls. Keep one
  // visibility-aware poll rather than letting each view query FXServer itself.
  useEffect(() => {
    if (!runtimeReadable) {
      setResourceStatuses({ resources: [], serverStateAvailable: false });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState !== "hidden") await refreshResourceStatuses();
      if (!cancelled) timer = setTimeout(poll, 5_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") void refreshResourceStatuses();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshResourceStatuses, runtimeReadable]);

  // Resolve the selected profile's resources/ and server.cfg paths whenever
  // the txData root or chosen profile changes, and point the live filesystem
  // watcher at that profile's folder so external changes (Explorer moves,
  // renames, etc.) get picked up automatically.
  useEffect(() => {
    let cancelled = false;
    if (!config.txDataPath || !config.selectedProfile) {
      setResolved(EMPTY_PROFILE);
      void window.api.fs.watchRoot(null);
      return () => { cancelled = true; };
    }
    void window.api.txdata.resolveProfile(config.txDataPath, config.selectedProfile)
      .then((nextResolved) => {
        if (cancelled) return;
        setResolved(nextResolved);
        void window.api.fs.watchRoot(nextResolved.profileRoot);
      })
      .catch((error) => {
        if (cancelled) return;
        setResolved(EMPTY_PROFILE);
        void window.api.fs.watchRoot(null);
        setSaveError(`Could not resolve the selected workspace: ${(error as Error).message}`);
      });
    return () => { cancelled = true; };
  }, [config.txDataPath, config.selectedProfile]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      resourceDragDepth.current += 1;
      setResourceDropActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      resourceDragDepth.current = Math.max(0, resourceDragDepth.current - 1);
      if (resourceDragDepth.current === 0 && !resourceDropImporting) setResourceDropActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      resourceDragDepth.current = 0;
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!resolved.resourcesPath) {
        setResourceDropActive(false);
        setResourceNotice({ message: t("resource.import.noWorkspace"), error: true });
        return;
      }
      if (files.length !== 1) {
        setResourceDropActive(false);
        setResourceNotice({ message: t("resource.import.oneFolder"), error: true });
        return;
      }
      setResourceDropImporting(true);
      setResourceDropActive(true);
      void window.api.resources.importDroppedFolder(files[0])
        .then((result) => {
          setTreeRefreshKey((key) => key + 1);
          setSidebarTab("resources");
          setResourceNotice({ message: t("resource.import.success", { resource: result.name, count: result.fileCount }), error: false });
          void openEditorLocation(result.manifestPath, 1, 1);
        })
        .catch((error) => setResourceNotice({ message: t("resource.import.failure", { message: (error as Error).message }), error: true }))
        .finally(() => {
          setResourceDropImporting(false);
          setResourceDropActive(false);
        });
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [resolved.resourcesPath, resourceDropImporting]);

  useEffect(() => {
    if (!resolved.resourcesPath) {
      setDependencyGraph({ nodes: [] });
      return;
    }
    let cancelled = false;
    void window.api.resources.dependencyGraph()
      .then((graph) => { if (!cancelled) setDependencyGraph(graph); })
      .catch(() => { if (!cancelled) setDependencyGraph({ nodes: [] }); });
    return () => { cancelled = true; };
  }, [resolved.resourcesPath, treeRefreshKey]);

  useEffect(() => {
    if (!config.txDataPath || !config.selectedProfile) {
      setBookmarks([]);
      return;
    }
    void window.api.bookmarks.list().then(setBookmarks).catch(() => setBookmarks([]));
  }, [config.txDataPath, config.selectedProfile]);

  // Bump the tree refresh token whenever the watcher reports a change.
  useEffect(() => {
    return window.api.fs.onChanged(() => {
      setTreeRefreshKey((k) => k + 1);
      void refreshResourceStatuses();
    });
  }, [refreshResourceStatuses]);

  useEffect(() => {
    let cancelled = false;
    if (!activePath) {
      setActiveResourceContext(null);
      return;
    }
    void window.api.resources.context(activePath)
      .then((context) => {
        if (!cancelled) setActiveResourceContext(context);
      })
      .catch(() => {
        if (!cancelled) setActiveResourceContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activePath, resolved.resourcesPath]);

  const dirtyOpenFileCount = openFiles.reduce((count, file) => count + (file.dirty ? 1 : 0), 0);

  // Keep the main process informed about unsaved work so it can warn on quit.
  // Content-only edits after the first dirty transition no longer emit IPC.
  useEffect(() => {
    window.api.app.setDirtyCount(dirtyOpenFileCount);
  }, [dirtyOpenFileCount]);

  // Discord receives a deliberately small activity projection. The main
  // process strips the path down to a bounded basename and derives language;
  // no workspace, resource, editor content, or chat text crosses this bridge.
  useEffect(() => {
    if (!configLoaded) return;
    let view: DiscordActivityView;
    let filePath: string | null = null;
    if (settingsOpen) {
      view = !config.txDataPath || !config.selectedProfile ? "setup" : "settings";
    } else if (assistantActive) {
      view = "assistant";
    } else if (centerTab === "editor") {
      view = activePath && reviewPath === activePath && Boolean(changeReviews[activePath]) ? "review" : "editor";
      filePath = activePath;
    } else {
      view = centerTab;
    }
    void window.api.app.setDiscordActivity({ view, filePath }).catch(() => {
      // Presence is optional; editor/navigation behavior must never depend on it.
    });
  }, [activePath, assistantActive, centerTab, changeReviews, config.selectedProfile, config.txDataPath, configLoaded, reviewPath, settingsOpen]);

  useEffect(() => {
    const open = new Set(openFiles.map((file) => file.path));
    const pruned = recentFilePaths.current.filter((path) => open.has(path));
    for (const file of openFiles) if (!pruned.includes(file.path)) pruned.push(file.path);
    if (activePath && !ctrlTabSession.current) {
      recentFilePaths.current = [activePath, ...pruned.filter((path) => path !== activePath)];
    } else {
      recentFilePaths.current = pruned;
    }
  }, [activePath, openFiles]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !event.ctrlKey || recentFilePaths.current.length < 2) return;
      event.preventDefault();
      if (!ctrlTabSession.current) {
        const order = [...recentFilePaths.current];
        ctrlTabSession.current = { order, index: Math.max(0, order.indexOf(activePathRef.current ?? "")) };
      }
      const session = ctrlTabSession.current;
      const direction = event.shiftKey ? -1 : 1;
      session.index = (session.index + direction + session.order.length) % session.order.length;
      setActivePath(session.order[session.index]);
      setCenterTab("editor");
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control" || !ctrlTabSession.current) return;
      const selected = activePathRef.current;
      const order = ctrlTabSession.current.order;
      recentFilePaths.current = selected ? [selected, ...order.filter((path) => path !== selected)] : order;
      ctrlTabSession.current = null;
    };
    const onBlur = () => {
      if (!ctrlTabSession.current) return;
      const selected = activePathRef.current;
      const order = ctrlTabSession.current.order;
      recentFilePaths.current = selected ? [selected, ...order.filter((path) => path !== selected)] : order;
      ctrlTabSession.current = null;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // A selection belongs to one editor model. Switching files or leaving the editor
  // must not leave a stale snippet attached to the next agent request.
  useEffect(() => {
    setSelection({ path: null, selectedText: "", startLine: 0, endLine: 0 });
  }, [activePath, centerTab]);

  // Keep the agent's view of the editor current: which file is open and what's selected.
  // Non-editor tabs deliberately expose neither a path nor a previous selection.
  useEffect(() => {
    void window.api.agent.setEditorContext({
      ...selection,
      path: centerTab === "editor" ? (selection.path ?? activePath) : null,
    }).catch(() => {
      // Context is advisory; a later editor move will retry it and chat remains usable.
    });
  }, [activePath, centerTab, selection]);

  // The agent can edit files directly. Reload a clean open buffer and retain a
  // reviewable before/after snapshot. If the user also has unsaved edits, leave
  // both versions untouched and open an explicit conflict review.
  useEffect(() => {
    return window.api.agent.onFileWritten(async (absolutePath) => {
      setTreeRefreshKey((k) => k + 1);
      const generation = (fileRefreshGeneration.current.get(absolutePath) ?? 0) + 1;
      fileRefreshGeneration.current.set(absolutePath, generation);
      if (!openFilesRef.current.some((file) => file.path === absolutePath)) return;
      try {
        const snapshot = await window.api.fs.readFile(absolutePath);
        if (fileRefreshGeneration.current.get(absolutePath) !== generation) return;
        const open = openFilesRef.current.find((file) => file.path === absolutePath);
        if (!open) return;
        if (snapshot.content === open.content) {
          if (!open.dirty) updateOpenFiles((files) => files.map((file) =>
            file.path === absolutePath ? { ...file, revision: snapshot.revision } : file,
          ));
          return;
        }
        const review: FileChangeReview = {
          id: ++reviewNonce.current,
          path: absolutePath,
          kind: open.dirty ? "conflict" : "agent",
          originalContent: open.content,
          modifiedContent: snapshot.content,
          originalLabel: open.dirty ? "Your unsaved editor version" : "Before agent change",
          modifiedLabel: open.dirty ? "Agent version on disk" : "Agent change now in editor",
          diskRevision: snapshot.revision,
        };
        setChangeReviews((current) => ({ ...current, [absolutePath]: review }));
        if (open.dirty) {
          setActivePath(absolutePath);
          setCenterTab("editor");
          setReviewPath(absolutePath);
        } else {
          updateOpenFiles((files) => files.map((f) =>
            f.path === absolutePath ? { ...f, ...snapshot, dirty: false } : f,
          ));
        }
      } catch {
        // file may have been removed again — the tree refresh above covers it
      }
    });
  }, [updateOpenFiles]);

  async function handleSaveSettings(next: StudioConfig, credentialUpdates: AgentCredentialUpdate[] = []) {
    const profileChanged = next.txDataPath !== config.txDataPath || next.selectedProfile !== config.selectedProfile;
    const dirtyCount = openFiles.filter((file) => file.dirty).length;
    if (
      profileChanged &&
      dirtyCount > 0 &&
      !confirm(
        `Switch profiles and discard unsaved changes in ${dirtyCount} open ${dirtyCount === 1 ? "file" : "files"}?`,
      )
    ) {
      throw new Error("Profile switch cancelled; your unsaved editor tabs are still open.");
    }
    const saved = await window.api.config.set(next, credentialUpdates);
    if (
      saved.activeCfxTarget !== config.activeCfxTarget ||
      saved.legacyFxServerExePath !== config.legacyFxServerExePath ||
      saved.enhancedFxServerExePath !== config.enhancedFxServerExePath ||
      saved.redmFxServerExePath !== config.redmFxServerExePath ||
      saved.txDataPath !== config.txDataPath ||
      saved.selectedProfile !== config.selectedProfile
    ) {
      serverStatusEpoch.current += 1;
    }
    setConfig(saved);
    void window.api.recents.list().then(setRecentWorkspaces).catch(() => setRecentWorkspaces([]));
    if (profileChanged) {
      openGenerationRef.current += 1;
      pendingOpensRef.current.clear();
      fileRefreshGeneration.current.clear();
      updateOpenFiles([]);
      setActivePath(null);
      setCenterTab("viewport");
      setEditorProblems({});
      setEditorReveal(null);
      setChangeReviews({});
      setReviewPath(null);
    }
    setTreeRefreshKey((k) => k + 1);
    if (saved.txDataPath && saved.selectedProfile) {
      await connect();
    } else {
      setConnected(false);
      setRuntimeIdentity(null);
      setWorkspaceMatch(null);
      setConnectError(null);
    }
  }

  async function handleSelectAgentTarget(target: AgentTarget) {
    const saved = await window.api.agent.selectTarget(target.connectionId, target.model);
    setConfig(saved);
  }

  async function handleConsoleRefreshIntervalChange(intervalMs: number) {
    const savedInterval = await window.api.console.setRefreshInterval(intervalMs);
    setConfig((current) => ({ ...current, consoleRefreshIntervalMs: savedInterval }));
  }

  async function switchRecentWorkspace(id: string) {
    const dirtyCount = openFiles.filter((file) => file.dirty).length;
    const allowDiscard = dirtyCount > 0 && confirm(
      `Switch workspaces and discard unsaved changes in ${dirtyCount} open ${dirtyCount === 1 ? "file" : "files"}?`,
    );
    if (dirtyCount > 0 && !allowDiscard) return;
    try {
      serverStatusEpoch.current += 1;
      const saved = await window.api.recents.select(id, allowDiscard);
      setConfig(saved);
      setConnected(false);
      setRuntimeIdentity(null);
      setWorkspaceMatch(null);
      openGenerationRef.current += 1;
      pendingOpensRef.current.clear();
      fileRefreshGeneration.current.clear();
      updateOpenFiles([]);
      setActivePath(null);
      setCenterTab("viewport");
      setEditorProblems({});
      setEditorReveal(null);
      setChangeReviews({});
      setReviewPath(null);
      setTreeRefreshKey((key) => key + 1);
      setRecentWorkspaces(await window.api.recents.list());
      await connect();
    } catch (error) {
      setSaveError(`Could not switch workspaces: ${(error as Error).message}`);
    }
  }

  async function openFile(path: string): Promise<boolean> {
    if (openFilesRef.current.some((file) => file.path === path)) {
      setActivePath(path);
      setCenterTab("editor");
      return true;
    }
    const existingRequest = pendingOpensRef.current.get(path);
    if (existingRequest) return existingRequest;
    const generation = openGenerationRef.current;
    const request = (async (): Promise<boolean> => {
      try {
        let snapshot: FileSnapshot | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const refreshGeneration = fileRefreshGeneration.current.get(path) ?? 0;
          snapshot = await window.api.fs.readFile(path);
          if ((fileRefreshGeneration.current.get(path) ?? 0) === refreshGeneration) break;
          snapshot = null;
        }
        if (!snapshot) throw new Error("The file kept changing while it was opening. Try again after the current write finishes.");
        if (openGenerationRef.current !== generation) return false;
        updateOpenFiles((files) => files.some((file) => file.path === path)
          ? files
          : [...files, { path, ...snapshot, dirty: false }]);
        setActivePath(path);
        setCenterTab("editor");
        return true;
      } catch (err) {
        alert((err as Error).message);
        return false;
      }
    })();
    pendingOpensRef.current.set(path, request);
    try {
      return await request;
    } finally {
      if (pendingOpensRef.current.get(path) === request) pendingOpensRef.current.delete(path);
    }
  }

  function handleEditorProblems(path: string, problems: EditorProblem[]) {
    setEditorProblems((current) => {
      if (problems.length === 0) {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      }
      const previous = current[path];
      if (
        previous?.length === problems.length &&
        previous.every((problem, index) => {
          const next = problems[index];
          return problem.severity === next.severity && problem.message === next.message &&
            problem.line === next.line && problem.column === next.column &&
            problem.endLine === next.endLine && problem.endColumn === next.endColumn &&
            problem.source === next.source && problem.code === next.code;
        })
      ) return current;
      return { ...current, [path]: problems };
    });
  }

  async function openEditorLocation(path: string, line: number, column: number) {
    if (!await openFile(path)) return;
    setReviewPath((current) => current === path ? null : current);
    setEditorReveal((current) => ({
      path,
      line,
      column,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }
  openEditorLocationRef.current = openEditorLocation;

  function revealEditorProblem(problem: EditorProblem) {
    void openEditorLocation(problem.path, problem.line, problem.column);
  }

  async function toggleBookmark(path: string, line: number) {
    try {
      setBookmarks(await window.api.bookmarks.toggle(path, line));
    } catch (error) {
      setSaveError(`Could not update bookmark: ${(error as Error).message}`);
    }
  }

  function closeTab(path: string) {
    const file = openFilesRef.current.find((f) => f.path === path);
    if (file?.dirty && !confirm(`${path.split(/[/\\]/).pop()} has unsaved changes.\n\nClose it and discard them?`)) {
      return;
    }
    updateOpenFiles((files) => files.filter((f) => f.path !== path));
    setChangeReviews((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    if (reviewPath === path) setReviewPath(null);
    setEditorProblems((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    if (activePath === path) {
      const remaining = openFilesRef.current.filter((f) => f.path !== path);
      setActivePath(remaining.length ? remaining[remaining.length - 1].path : null);
      // Closing the last file would otherwise leave the editor selected with nothing
      // in it and no tab highlighted — fall back to the viewport instead.
      if (remaining.length === 0) setCenterTab("viewport");
    }
  }

  function updateContent(path: string, content: string) {
    updateOpenFiles((files) => files.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)));
  }

  async function runResourceLifecycle(
    kind: "start" | "stop" | "restart",
    name: string,
    source: "manual" | "save" = "manual",
  ): Promise<boolean> {
    if (!runtimeWritable || resourceAction) return false;
    if (kind === "stop") {
      const dependents = dependencyGraph.nodes.find((node) => node.name.toLowerCase() === name.toLowerCase())?.dependents ?? [];
      const message = dependents.length > 0
        ? t("resource.confirmStopDependents", { resource: name, dependents: dependents.join(", ") })
        : t("resource.confirmStop", { resource: name });
      if (!confirm(message)) return false;
    }

    setResourceAction(`${kind}:${name}`);
    setResourceNotice(null);
    try {
      const tool = kind === "start" ? "start_resource" : kind === "stop" ? "stop_resource" : "restart_resource";
      await window.api.mcp.callTool(tool, { name });
      await refreshResourceStatuses(true);
      const action = kind === "start" ? "started" : kind === "stop" ? "stopped" : "restarted";
      setResourceNotice({
        message: source === "save" && kind === "restart"
          ? t("editor.savedAndRestarted", { resource: name })
          : t("resource.actionSuccess", { resource: name, action }),
        error: false,
      });
      if (kind === "restart") {
        setConsoleRefreshSignal((current) => ({ resource: name, nonce: (current?.nonce ?? 0) + 1 }));
        setCenterTab("console");
      }
      return true;
    } catch (err) {
      setResourceNotice({
        message: t("resource.actionFailure", {
          resource: name,
          action: kind,
          message: (err as Error).message || "Unknown error",
        }),
        error: true,
      });
      return false;
    } finally {
      setResourceAction(null);
    }
  }

  // A rename/delete from the resource tree can affect a path that's the exact
  // match (a file itself) or an ancestor (a folder containing open tabs) —
  // handle both so open tabs stay in sync with what's on disk.
  function remapPath(p: string, oldPath: string, newPath: string): string | null {
    if (p === oldPath) return newPath;
    if (p.startsWith(oldPath + "\\") || p.startsWith(oldPath + "/")) return newPath + p.slice(oldPath.length);
    return null;
  }

  function handlePathRenamed(oldPath: string, newPath: string) {
    updateOpenFiles((files) => files.map((f) => {
      const remapped = remapPath(f.path, oldPath, newPath);
      return remapped ? { ...f, path: remapped } : f;
    }));
    setActivePath((p) => (p ? (remapPath(p, oldPath, newPath) ?? p) : p));
    setReviewPath((p) => (p ? (remapPath(p, oldPath, newPath) ?? p) : p));
    setChangeReviews((current) => Object.fromEntries(
      Object.entries(current).map(([reviewedPath, review]) => {
        const remapped = remapPath(reviewedPath, oldPath, newPath) ?? reviewedPath;
        return [remapped, { ...review, path: remapPath(review.path, oldPath, newPath) ?? review.path }];
      }),
    ));
    setEditorProblems((current) => Object.fromEntries(
      Object.entries(current).map(([problemPath, problems]) => {
        const remapped = remapPath(problemPath, oldPath, newPath) ?? problemPath;
        return [remapped, problems.map((problem) => ({
          ...problem,
          path: remapPath(problem.path, oldPath, newPath) ?? problem.path,
        }))];
      }),
    ));
    setBookmarks((current) => current.map((bookmark) => ({
      ...bookmark,
      path: remapPath(bookmark.path, oldPath, newPath) ?? bookmark.path,
    })));
    setTreeRefreshKey((k) => k + 1);
  }

  function handlePathDeleted(deletedPath: string) {
    const affected = (p: string) => p === deletedPath || p.startsWith(deletedPath + "\\") || p.startsWith(deletedPath + "/");
    const remaining = openFilesRef.current.filter((f) => !affected(f.path));
    updateOpenFiles(remaining);
    setChangeReviews((current) => Object.fromEntries(
      Object.entries(current).filter(([reviewedPath]) => !affected(reviewedPath)),
    ));
    if (reviewPath && affected(reviewPath)) setReviewPath(null);
    setEditorProblems((current) => Object.fromEntries(
      Object.entries(current).filter(([problemPath]) => !affected(problemPath)),
    ));
    setBookmarks((current) => current.filter((bookmark) => !affected(bookmark.path)));
    if (activePath && affected(activePath)) {
      setActivePath(remaining.length ? remaining[remaining.length - 1].path : null);
      if (remaining.length === 0) setCenterTab("viewport");
    }
    setTreeRefreshKey((k) => k + 1);
  }

  async function deleteEntry(path: string, name: string): Promise<boolean> {
    const affected = (candidate: string) =>
      candidate === path || candidate.startsWith(path + "\\") || candidate.startsWith(path + "/");
    const dirtyCount = openFiles.filter((file) => affected(file.path) && file.dirty).length;
    const unsavedWarning = dirtyCount
      ? `\n\n${dirtyCount} open ${dirtyCount === 1 ? "file has" : "files have"} unsaved changes that will be discarded.`
      : "";
    if (!confirm(`Move "${name}" to the Recycle Bin?${unsavedWarning}`)) return false;
    try {
      await window.api.fs.delete(path);
      handlePathDeleted(path);
      return true;
    } catch (err) {
      alert((err as Error).message);
      return false;
    }
  }

  async function performSave(path: string, content: string, expectedRevision: string) {
    setSaveError(null);
    try {
      // A queued save may have captured the revision that preceded an earlier
      // queued write. Always serialize against the latest reconciled revision.
      const current = openFilesRef.current.find((file) => file.path === path);
      const revision = await window.api.fs.writeFile(path, content, current?.revision ?? expectedRevision);
      updateOpenFiles((files) => files.map((file) => file.path === path
        ? reconcileSuccessfulSave(file, content, revision)
        : file));

      if (config.editor.restartResourceOnSave && runtimeWritable) {
        const context = await window.api.resources.context(path).catch(() => null);
        if (context && resourceStates[context.name.toLowerCase()] === "started") {
          await runResourceLifecycle("restart", context.name, "save");
        }
      }
    } catch (err) {
      const message = `Could not save ${path.split(/[/\\]/).pop()}: ${(err as Error).message}`;
      setSaveError(message);
      if ((err as Error).message.includes("changed on disk")) {
        try {
          const disk = await window.api.fs.readFile(path);
          const latestEditor = openFilesRef.current.find((file) => file.path === path);
          const review: FileChangeReview = {
            id: ++reviewNonce.current,
            path,
            kind: "conflict",
            originalContent: latestEditor?.content ?? content,
            modifiedContent: disk.content,
            originalLabel: "Your unsaved editor version",
            modifiedLabel: "Current version on disk",
            diskRevision: disk.revision,
          };
          setChangeReviews((current) => ({ ...current, [path]: review }));
          setReviewPath(path);
          setActivePath(path);
          setCenterTab("editor");
        } catch {
          // Preserve the original save failure when the changed file also vanished.
        }
      }
      throw new Error(message);
    }
  }

  async function saveFile(path: string, content: string, expectedRevision: string) {
    await saveQueueRef.current.run(path.toLowerCase(), () => performSave(path, content, expectedRevision));
  }

  function openChangeReview(path: string) {
    if (!changeReviews[path]) return;
    setActivePath(path);
    setCenterTab("editor");
    setReviewPath(path);
  }

  function clearChangeReview(path: string) {
    setChangeReviews((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    setReviewPath((current) => current === path ? null : current);
  }

  async function useDiskVersion(review: FileChangeReview) {
    const observed = openFilesRef.current.find((file) => file.path === review.path);
    if (!observed) return;
    try {
      const latest = await window.api.fs.readFile(review.path);
      const current = openFilesRef.current.find((file) => file.path === review.path);
      if (!current || current.content !== observed.content || current.revision !== observed.revision) {
        setSaveError(`Could not reload ${review.path.split(/[/\\]/).pop()}: the editor changed while the disk version was loading.`);
        return;
      }
      updateOpenFiles((files) => files.map((file) => file.path === review.path
        ? { ...file, ...latest, dirty: false }
        : file));
      setSaveError(null);
      clearChangeReview(review.path);
    } catch (error) {
      setSaveError(`Could not reload ${review.path.split(/[/\\]/).pop()}: ${(error as Error).message}`);
    }
  }

  async function saveEditorVersion(review: FileChangeReview) {
    const open = openFiles.find((file) => file.path === review.path);
    if (!open) return;
    try {
      await saveFile(review.path, open.content, review.diskRevision);
      clearChangeReview(review.path);
    } catch {
      // saveFile refreshed the conflict review if the disk changed again.
    }
  }

  async function launchCfxClient() {
    if (!activeClientPath) return;
    try {
      const result = await window.api.cfx.launch(config.activeCfxTarget);
      setCenterTab("viewport");
      setClientAutoAttachRequest((current) => ({
        target: result.target,
        launchPid: result.launchPid,
        nonce: (current?.nonce ?? 0) + 1,
      }));
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function launchServer() {
    if (!activeServerPath || !config.txDataPath || !config.selectedProfile || serverAction) return;
    serverStatusEpoch.current += 1;
    setServerAction("starting");
    setServerNotice(null);
    try {
      const result = await window.api.server.launch();
      if (result.recoveryNotice) setArtifactNotice(result.recoveryNotice);
      setServerRunning(true);
      observedServerRunning.current = true;
      intentionalServerStop.current = false;
      serverLaunchedInIdentity.current = !result.alreadyRunning;
      setServerStartedAt(Date.now());
      setServerPids([result.pid]);
      setServerTarget(result.target);
      setServerStatusError(null);
      setServerNotice({
        message: result.alreadyRunning
          ? `The ${cfxTargetLabel(result.target)} local server is already running.`
          : `${cfxTargetLabel(result.target)} local server started. Use Stop server here or stop it in txAdmin.`,
        error: false,
      });
    } catch (err) {
      setServerNotice({ message: `Could not start the local server: ${(err as Error).message}`, error: true });
    } finally {
      const settledEpoch = ++serverStatusEpoch.current;
      await refreshServerStatus(settledEpoch);
      setServerAction(null);
    }
  }

  async function stopServer() {
    if (serverAction) return;
    serverStatusEpoch.current += 1;
    intentionalServerStop.current = true;
    setServerAction("stopping");
    setServerNotice(null);
    try {
      const result = await window.api.server.stop(serverTarget);
      setServerRunning(false);
      observedServerRunning.current = false;
      serverLaunchedInIdentity.current = false;
      setServerStartedAt(null);
      setServerPids([]);
      setServerStatusError(null);
      setServerNotice({
        message: result.alreadyStopped
          ? `The ${cfxTargetLabel(result.target)} local server is already stopped.`
          : `Stopped the ${cfxTargetLabel(result.target)} local server.`,
        error: false,
      });
    } catch (err) {
      intentionalServerStop.current = false;
      setServerNotice({ message: `Could not stop the local server: ${(err as Error).message}`, error: true });
    } finally {
      const settledEpoch = ++serverStatusEpoch.current;
      await refreshServerStatus(settledEpoch);
      setServerAction(null);
    }
  }

  async function restartServer() {
    if (!serverRunning || serverAction) return;
    serverStatusEpoch.current += 1;
    intentionalServerStop.current = true;
    setServerAction("restarting");
    setServerNotice(null);
    try {
      const result = await window.api.server.restart(serverTarget);
      setServerRunning(false);
      observedServerRunning.current = false;
      serverLaunchedInIdentity.current = false;
      setServerStartedAt(null);
      setServerPids([]);
      if (result.recoveryNotice) setArtifactNotice(result.recoveryNotice);
      setServerRunning(true);
      observedServerRunning.current = true;
      intentionalServerStop.current = false;
      serverLaunchedInIdentity.current = !result.alreadyRunning;
      setServerStartedAt(Date.now());
      setServerPids([result.pid]);
      setServerTarget(result.target);
      setServerStatusError(null);
      setServerNotice({
        message: `Restarted the ${cfxTargetLabel(result.target)} local server.`,
        error: false,
      });
    } catch (err) {
      intentionalServerStop.current = false;
      setServerNotice({ message: `Could not restart the local server: ${(err as Error).message}`, error: true });
    } finally {
      const settledEpoch = ++serverStatusEpoch.current;
      await refreshServerStatus(settledEpoch);
      setServerAction(null);
    }
  }

  const statusItems: StatusItem[] = [];
  if (saveError) statusItems.push({ id: "save", tone: "error", content: saveError, onDismiss: () => setSaveError(null) });
  if (serverNotice) statusItems.push({
    id: "server",
    tone: serverNotice.error ? "error" : "info",
    content: serverNotice.message,
    onDismiss: () => setServerNotice(null),
  });
  if (resourceNotice) statusItems.push({
    id: "resource",
    tone: resourceNotice.error ? "error" : "info",
    content: resourceNotice.message,
    onDismiss: () => setResourceNotice(null),
  });
  if (connected && workspaceMatch && !workspaceMatch.ok) statusItems.push({
    id: "workspace-mismatch",
    tone: "error",
    content: `Bundled runtime is read-only: ${workspaceMatch.reason} Resource refresh actions are blocked until the workspace identity matches.`,
  });
  if (configLoaded && (!config.txDataPath || !config.selectedProfile)) statusItems.push({
    id: "setup",
    tone: "warning",
    content: "Choose a local txData root and server-data workspace before coding.",
    actions: <button className="btn small" onClick={openSettings}>Open Settings</button>,
  });
  if (!connected && connectError) statusItems.push({
    id: "connection",
    tone: "warning",
    content: `Local coding runtime unavailable: ${connectError} — retrying automatically.`,
  });
  if (artifactNotice) statusItems.push({
    id: "artifact",
    tone: "warning",
    content: artifactNotice,
    onDismiss: () => setArtifactNotice(null),
  });
  if (appUpdateState?.phase === "available" && appUpdateState.latestVersion && appUpdateState.latestVersion !== dismissedUpdateVersion) {
    const availableVersion = appUpdateState.latestVersion;
    statusItems.push({
      id: "update-available",
      tone: "info",
      content: t("appUpdate.banner.available", { version: availableVersion }),
      actions: <button className="btn small" onClick={() => void downloadAppUpdate().catch(() => undefined)}>{t("appUpdate.download")}</button>,
      onDismiss: () => setDismissedUpdateVersion(availableVersion),
    });
  }
  if (appUpdateState?.phase === "downloading") statusItems.push({
    id: "update-downloading",
    tone: "info",
    content: t("appUpdate.banner.downloading", { version: appUpdateState.latestVersion ?? "update" }),
  });
  if (appUpdateState?.phase === "ready") statusItems.push({
    id: "update-ready",
    tone: "info",
    content: t("appUpdate.banner.ready", { version: appUpdateState.latestVersion ?? "update" }),
    actions: <button className="btn small primary" onClick={() => void restartToAppUpdate().catch(() => undefined)}>{t("appUpdate.restart")}</button>,
  });
  if (appUpdateState?.phase === "error" && appUpdateState.error) statusItems.push({
    id: "update-error",
    tone: "warning",
    content: appUpdateState.error,
    actions: <button className="btn small" onClick={() => void checkForAppUpdate().catch(() => undefined)}>{t("appUpdate.banner.retry")}</button>,
  });

  return (
    <div className="app-shell">
      <TopBar
        appVersion={appUpdateState?.currentVersion ?? "…"}
        connected={connected}
        runtimeIdentity={runtimeIdentity}
        workspaceMatch={workspaceMatch}
        onOpenSettings={openSettings}
        onLaunchServer={launchServer}
        onStopServer={stopServer}
        onRestartServer={restartServer}
        onLaunchClient={launchCfxClient}
        onOpenWorkspace={() => resolved.profileRoot && void window.api.shell.showItemInFolder(resolved.profileRoot)}
        activeTarget={config.activeCfxTarget}
        serverTarget={serverTarget}
        activeServerPath={activeServerPath}
        serverConfigured={Boolean(config.txDataPath && config.selectedProfile)}
        serverAction={serverAction}
        serverRunning={serverRunning}
        serverPids={serverPids}
        serverStartedAt={serverStartedAt}
        serverStatusError={serverStatusError}
        activeClientPath={activeClientPath}
        workspacePath={resolved.profileRoot || null}
        recentWorkspaces={recentWorkspaces}
        onSelectRecentWorkspace={(id) => void switchRecentWorkspace(id)}
      />

      <StatusArea items={statusItems} />

      <div style={{ flex: 1, minHeight: 0 }}>
        <Group orientation="horizontal">
          <Panel defaultSize="20" minSize="14">
            <div className="pane">
              <div className="tabbar" role="tablist" aria-label="Sidebar views">
                <button
                  className={`tab ${sidebarTab === "resources" ? "active" : ""}`}
                  role="tab"
                  aria-selected={sidebarTab === "resources"}
                  onClick={() => setSidebarTab("resources")}
                >
                  Resources
                </button>
                <button
                  className={`tab ${sidebarTab === "search" ? "active" : ""}`}
                  role="tab"
                  aria-selected={sidebarTab === "search"}
                  onClick={() => setSidebarTab("search")}
                >
                  {t("search.tab")}
                </button>
                <button
                  className={`tab ${sidebarTab === "bookmarks" ? "active" : ""}`}
                  role="tab"
                  aria-selected={sidebarTab === "bookmarks"}
                  onClick={() => setSidebarTab("bookmarks")}
                >
                  {t("bookmarks.tab")}
                </button>
                <button
                  className={`tab ${sidebarTab === "github" ? "active" : ""}`}
                  role="tab"
                  aria-selected={sidebarTab === "github"}
                  onClick={() => setSidebarTab("github")}
                >
                  GitHub
                </button>
              </div>
              <div className="pane-body">
                {sidebarTab === "resources" ? (
                  <>
                    {resolved.serverCfgPath && (
                      <button
                        className={`tree-node pinned-entry ${activePath === resolved.serverCfgPath ? "selected" : ""}`}
                        style={{ paddingLeft: 8 }}
                        onClick={() => openFile(resolved.serverCfgPath!)}
                      >
                        <span className="icon">📄</span>
                        <span>server.cfg</span>
                      </button>
                    )}
                    <ResourceTree
                      rootPath={resolved.resourcesPath}
                      selectedPath={activePath}
                      onOpenFile={openFile}
                      refreshKey={treeRefreshKey}
                      onPathRenamed={handlePathRenamed}
                      onDeleteEntry={deleteEntry}
                      resourceStates={resourceStates}
                      serverStateAvailable={resourceStatuses.serverStateAvailable}
                      runtimeWritable={runtimeWritable}
                      resourceAction={resourceAction}
                      onResourceAction={runResourceLifecycle}
                      onResourceDuplicated={(sourceName, result) => {
                        setTreeRefreshKey((key) => key + 1);
                        setResourceNotice({
                          message: t("resource.duplicate.success", { resource: result.name, source: sourceName, count: result.fileCount }),
                          error: false,
                        });
                        void openEditorLocation(result.manifestPath, 1, 1);
                      }}
                      onEntryCreated={(result) => {
                        setTreeRefreshKey((key) => key + 1);
                        setResourceNotice({
                          message: t(`resource.create.success.${result.isDirectory ? "folder" : "file"}`, { name: result.name }),
                          error: false,
                        });
                        if (!result.isDirectory) void openEditorLocation(result.path, 1, 1);
                      }}
                      onStarterCreated={(result) => {
                        setTreeRefreshKey((key) => key + 1);
                        setResourceNotice({
                          message: t("resource.create.success.resource", { name: result.name, count: result.fileCount }),
                          error: false,
                        });
                        void openEditorLocation(result.manifestPath, 1, 1);
                      }}
                    />
                  </>
                ) : sidebarTab === "search" ? (
                  <SearchPanel
                    workspaceRoot={resolved.resourcesPath}
                    activeResource={activeResourceContext}
                    resolvedTheme={resolvedTheme}
                    editorPreferences={config.editor}
                    onOpenLocation={(path, line, column) => void openEditorLocation(path, line, column)}
                    onFilesChanged={() => setTreeRefreshKey((key) => key + 1)}
                  />
                ) : sidebarTab === "bookmarks" ? (
                  <BookmarksPanel
                    bookmarks={bookmarks}
                    onOpen={(path, line) => void openEditorLocation(path, line, 1)}
                    onRemove={(path, line) => void toggleBookmark(path, line)}
                  />
                ) : (
                  <GithubImportPanel projectRoot={resolved.resourcesPath} onImported={() => setTreeRefreshKey((k) => k + 1)} />
                )}
              </div>
            </div>
          </Panel>

          <Separator className="resize-handle resize-handle-h" />

          <Panel defaultSize="55" minSize="30">
            <CenterPane
              connected={connected}
              runtimeReadable={runtimeReadable}
              runtimeWritable={runtimeWritable}
              consoleAvailable={connected && workspaceMatch?.ok === true ? (runtimeIdentity?.capabilities.console ?? null) : null}
              consoleRefreshIntervalMs={config.consoleRefreshIntervalMs}
              onConsoleRefreshIntervalChange={handleConsoleRefreshIntervalChange}
              resourceLifecycleAvailable={runtimeIdentity?.capabilities.resourceLifecycle ?? null}
              clientLabel={activeTargetLabel}
              clientAutoAttachRequest={clientAutoAttachRequest}
              activeCfxTarget={config.activeCfxTarget}
              editorPreferences={config.editor}
              resolvedTheme={resolvedTheme}
              editorProblems={editorProblems}
              editorReveal={editorReveal}
              changeReviews={changeReviews}
              reviewPath={reviewPath}
              centerTab={centerTab}
              onSelectCenterTab={setCenterTab}
              openFiles={openFiles}
              activePath={activePath}
              activeResourceContext={activeResourceContext}
              activeResourceState={activeResourceContext && resourceStatuses.serverStateAvailable
                ? resourceStates[activeResourceContext.name.toLowerCase()]
                : undefined}
              resourceAction={resourceAction}
              onResourceAction={runResourceLifecycle}
              consoleRefreshSignal={consoleRefreshSignal}
              crashTriage={crashTriage}
              onDismissCrashTriage={() => setCrashTriage(null)}
              onSendCrashTriage={(text) => offerAgentPrompt(text, "draft")}
              onConsoleOutputChange={(output) => { latestConsoleOutput.current = output; }}
              onAgentPrompt={(text) => offerAgentPrompt(text, "draft")}
              dependencyGraph={dependencyGraph}
              bookmarks={bookmarks}
              onToggleBookmark={(path, line) => void toggleBookmark(path, line)}
              onSelectFileTab={(path) => {
                setSelection({ path: null, selectedText: "", startLine: 0, endLine: 0 });
                setActivePath(path);
              }}
              onCloseFileTab={closeTab}
              onChange={updateContent}
              onSave={saveFile}
              onSelectionChange={(path, selectedText, startLine, endLine) =>
                setSelection({ path, selectedText, startLine, endLine })
              }
              onProblemsChange={handleEditorProblems}
              onRevealProblem={revealEditorProblem}
              onOpenEditorLocation={(path, line, column) => void openEditorLocation(path, line, column)}
              onOpenReview={openChangeReview}
              onCloseReview={() => setReviewPath(null)}
              onDismissReview={(review) => clearChangeReview(review.path)}
              onUseDiskVersion={(review) => void useDiskVersion(review)}
              onSaveEditorVersion={(review) => void saveEditorVersion(review)}
            />
          </Panel>

          <Separator className="resize-handle resize-handle-h" />

          <Panel defaultSize="25" minSize="18">
            <ChatPanel
              key={currentAgentPromptScope}
              connected={connected}
              config={config}
              resolvedTheme={resolvedTheme}
              workspaceMatch={workspaceMatch}
              selection={selection.selectedText ? selection : null}
              suggestedPrompt={agentPrompt}
              onSuggestedPromptConsumed={consumeAgentPrompt}
              activePath={activePath}
              activeResourceName={activeResourceContext?.name ?? null}
              onActivityChange={setAssistantActive}
              onSelectAgentTarget={handleSelectAgentTarget}
              onOpenAgentSettings={openAgentSettings}
            />
          </Panel>
        </Group>
      </div>

      {resourceDropActive && (
        <div className="resource-drop-overlay" role="status" aria-live="polite">
          <div className="resource-drop-card">
            <strong>{resourceDropImporting ? t("resource.import.importing") : t("resource.import.drop")}</strong>
            <span>{resourceDropImporting ? t("resource.import.importingHelp") : t("resource.import.dropHelp")}</span>
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          config={config}
          themePacks={themePacks}
          appUpdateState={appUpdateState ?? LOADING_APP_UPDATE_STATE}
          appUpdateBusy={appUpdateBusy}
          initialSection={settingsInitialSection}
          onCheckAppUpdate={checkForAppUpdate}
          onDownloadAppUpdate={downloadAppUpdate}
          onRestartAppUpdate={restartToAppUpdate}
          onThemePreview={previewTheme}
          onReloadThemePacks={reloadThemePacks}
          onSave={handleSaveSettings}
          onClose={closeSettings}
        />
      )}
      {whatsNew && <WhatsNewPanel currentVersion={whatsNew.currentVersion} onClose={() => setWhatsNew(null)} />}
    </div>
  );
}
