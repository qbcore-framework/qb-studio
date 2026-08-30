import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Notification, clipboard, screen, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import {
  loadConfig,
  normalizeConfig,
  recoverConfigTransaction,
  saveConfig,
  saveConfigWithConnectionKeys,
  hasConnectionKey,
  CFX_TARGETS,
  type CfxTarget,
  type StudioConfig,
  type ThemePreference,
} from "./configStore";
import * as agent from "./agent";
import {
  agentRuntimeSignature,
  requireAgentConnectionId,
  requireAgentConnectionProbe,
  requireAgentCredentialUpdates,
  requireAgentSettingsUpdate,
  requireConnectionKey,
  withAgentTarget,
  withCredentialRevision,
} from "./agentConnectionPolicy";
import { listDir, readTextFileSnapshot, writeTextFile, renamePath, listProfiles, resolveProfile } from "./fsTree";
import { watchPath, stopWatching } from "./fsWatch";
import {
  mcpConnect,
  mcpDisconnect,
  mcpCallTool,
  mcpIsConnected,
  mcpConnectedUrl,
  mcpRuntimeIdentity,
  mcpRuntimeWorkspaceMatch,
  mcpListResourceStatuses,
  setOnDropped,
} from "./mcpClient";
import { fetchRepoInfo, searchGithubRepos, listGithubOrganizationRepos, cloneRepo } from "./githubClient";
import * as windowEmbed from "./windowEmbed";
import { setEditorContext, setOnFileWritten, setProjectRevertStore, type EditorContext } from "./projectTools";
import { assertSafeBasename, contains, resolveInsideRoot } from "./pathSafety";
import { resolveToolApproval } from "./toolApproval";
import {
  applyDevelopmentRcon,
  createLocalWorkspace,
  previewDevelopmentRcon,
} from "./workspaceCreator";
import {
  discoverTxAdminControlProfile,
  ensureManagedRuntime,
  loadLocalServerConfig,
  parseLocalServerConfig,
  stopManagedRuntime,
} from "./managedRuntime";
import { OperationLock } from "./operationLock";
import { LuaLanguageServerProcess, type JsonRpcMessage } from "./luaLanguageServer";
import {
  checkArtifactUpdate,
  findRunningServerPids,
  installArtifactUpdate,
  launchLocalServer,
  recoverInterruptedArtifactUpdate,
  resolveArtifactTarget,
  stopLocalServer,
  type ArtifactTrack,
} from "./serverArtifacts";
import { AppUpdateController, appUpdateRestartBlockReason, type AppUpdateState } from "./appUpdate";
import { resourceAtDirectory, resolveResourceContext } from "./resourceContext";
import { RevertStore, type RevertMode } from "./revertStore";
import { detectConventionalClientInstalls, detectConventionalExecutables } from "./clientInstallDiscovery";
import { WorkspaceSearchService } from "./workspaceSearch";
import { newestCrashReport } from "./crashTriage";
import { loadWindowState, saveWindowState } from "./windowState";
import { listRecentWorkspaces, recordRecentWorkspace, resolveRecentWorkspace } from "./recentWorkspaces";
import { consumeWhatsNew } from "./whatsNew";
import { buildResourceDependencyGraph } from "./dependencyGraph";
import { assertFxServerPortAvailable } from "./portPreflight";
import { BookmarkStore } from "./bookmarkStore";
import { compareResources } from "./resourceCompare";
import { duplicateResource } from "./resourceDuplicate";
import { importResourceFolder } from "./resourceImport";
import { DiscordPresence } from "./discordPresence";
import { ThemePackStore, customThemeId, themeBaseForPreference } from "./themePacks";
import { invalidateConsoleSourceIndex, resolveConsoleSourceLocation } from "./consoleSourceResolver";
import { agentPromptWorkspaceScope } from "./agentPromptDecision";
import { createResourceDirectory, createResourceFile, createStarterResource } from "./resourceCreation";
import { requireStarterResourceTemplate } from "./resourceTemplates";
import { prepareConsoleAgentFix } from "./consoleAgentFix";

let mainWindow: BrowserWindow | null = null;
let consoleWindow: BrowserWindow | null = null;
let appUpdateController: AppUpdateController | null = null;
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

// How many editor tabs currently hold unsaved edits, pushed from the renderer —
// used to guard against quitting Studio and silently losing them.
let dirtyFileCount = 0;
let allowCloseWithUnsavedChanges = false;
// A folder becomes eligible for profile discovery only after the native picker
// returned it. This prevents the renderer from turning discovery into an
// arbitrary-directory listing API.
let pendingTxDataPath: string | null = null;
const pendingClientExePaths: Record<CfxTarget, string | null> = { legacy: null, enhanced: null, redm: null };
const pendingFxServerExePaths: Record<CfxTarget, string | null> = { legacy: null, enhanced: null, redm: null };
let artifactRecoveryNotice: string | null = null;
const serverOperation = new OperationLock();
const luaLanguageServer = new LuaLanguageServerProcess();
let revertStore: RevertStore | null = null;
let workspaceSearch: WorkspaceSearchService | null = null;
let bookmarkStore: BookmarkStore | null = null;
let themePackStore: ThemePackStore | null = null;
const discordPresence = new DiscordPresence();
let consoleClearGeneration = 0;
let previewThemePreference: ThemePreference | null = null;

// The renderer only receives the coding-oriented runtime controls it renders.
// Gameplay/admin tooling is deliberately not exposed through this generic bridge.
const RENDERER_MCP_TOOLS = new Set([
  "get_console_output",
  "list_resources",
  "start_resource",
  "stop_resource",
  "restart_resource",
]);

function requireString(value: unknown, label: string, maxLength = 32767): string {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${label} must be a string up to ${maxLength} characters.`);
  return value;
}

function broadcastConfig(config: StudioConfig): void {
  for (const window of [mainWindow, consoleWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send("config:changed", config);
  }
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function requireMainWindowSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error("This action is available only from the main QB Studio window.");
  }
}

function requireStudioWindowSender(event: IpcMainInvokeEvent): void {
  const allowed = [mainWindow, consoleWindow].some((window) =>
    window && !window.isDestroyed() && event.sender === window.webContents,
  );
  if (!allowed) throw new Error("Console actions are available only from a QB Studio window.");
}

function clearConsoleViews(): number {
  consoleClearGeneration += 1;
  for (const window of [mainWindow, consoleWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send("console:clearViewChanged", consoleClearGeneration);
  }
  return consoleClearGeneration;
}

function requireAppUpdateController(): AppUpdateController {
  if (!appUpdateController) throw new Error("Application updates are not ready yet.");
  return appUpdateController;
}

function broadcastAppUpdateState(state: AppUpdateState): void {
  // A failed installer launch leaves the app running; restore the ordinary
  // close guard so edits made afterward can never bypass its warning.
  if (state.phase === "error") allowCloseWithUnsavedChanges = false;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:updateState", state);
}

function requireRevertStore(): RevertStore {
  if (!revertStore) throw new Error("Undo history is not ready yet.");
  return revertStore;
}

function requireWorkspaceSearch(): WorkspaceSearchService {
  if (!workspaceSearch) throw new Error("Workspace search is not ready yet.");
  return workspaceSearch;
}

function requireRevertMode(value: unknown): RevertMode {
  if (value !== "all" && value !== "safe") throw new Error("Undo mode must be 'all' or 'safe'.");
  return value;
}

function isRegularUnlinkedFile(filePath: string | null): boolean {
  if (!filePath) return false;
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function selectedProfileRoot(txDataValue: unknown, profileValue: unknown): { txDataPath: string; profileRoot: string } {
  const txDataPath = scopedTxDataPath(txDataValue);
  const profile = assertSafeBasename(requireString(profileValue, "Profile", 255));
  const profileRoot = resolveInsideRoot(txDataPath, profile);
  const stat = fs.lstatSync(profileRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The selected workspace must be a real directory.");
  return { txDataPath, profileRoot };
}

function workspaceHasRconPassword(profileRoot: string): boolean {
  try {
    return Boolean(parseLocalServerConfig(loadLocalServerConfig(profileRoot)).rconPassword);
  } catch {
    // A missing include or endpoint should not hide a direct credential when
    // deciding whether rotation needs explicit confirmation.
    let visible = "";
    for (const name of ["server.cfg", "secrets.cfg"]) {
      try { visible += `\n${fs.readFileSync(resolveInsideRoot(profileRoot, name), "utf8")}`; } catch { /* absent/inaccessible */ }
    }
    return /^\s*(?:set\s+)?rcon_password\s+.+$/im.test(visible);
  }
}

function requireJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LuaLS message must be an object.");
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") throw new Error("LuaLS message must use JSON-RPC 2.0.");
  if (typeof message.method === "string" && message.method.length > 256) throw new Error("LuaLS method name is too long.");
  if (Buffer.byteLength(JSON.stringify(message)) > 8 * 1024 * 1024) throw new Error("LuaLS message is too large.");
  return message;
}

function activeProfileRoot(): string {
  const config = loadConfig();
  if (!config.txDataPath || !config.selectedProfile) throw new Error("Choose a txData folder and server profile first.");
  const profile = assertSafeBasename(config.selectedProfile);
  const root = resolveInsideRoot(config.txDataPath, profile);
  if (!fs.existsSync(root)) throw new Error("The selected server profile no longer exists.");
  return root;
}

function activeResourcesRoot(): string {
  const config = loadConfig();
  const root = activeProfileRoot();
  const resources = resolveProfile(config.txDataPath!, config.selectedProfile!).resourcesPath;
  if (!resources) throw new Error("The selected profile has no resources folder.");
  return resources;
}

function starterTemplateCatalogRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "resource-templates")
    : path.join(app.getAppPath(), "resources", "resource-templates");
}

function scopedProfilePath(value: unknown): string {
  const root = activeProfileRoot();
  const requested = requireString(value, "Path");
  return resolveInsideRoot(root, path.relative(root, requested));
}

function listProfileDirectory(value: unknown) {
  const target = scopedProfilePath(value);
  const entries = listDir(target);
  let resourcesRoot: string;
  try {
    resourcesRoot = activeResourcesRoot();
  } catch {
    return entries;
  }
  return entries.map((entry) => {
    if (!entry.isDirectory || !contains(resourcesRoot, entry.path) || /^\[[^\[\]\\/]+\]$/.test(entry.name)) return entry;
    const context = resourceAtDirectory(resourcesRoot, entry.path);
    return context ? { ...entry, resourceName: context.name } : entry;
  });
}

function activeResourceContext(value: unknown) {
  const target = scopedProfilePath(value);
  const resourcesRoot = activeResourcesRoot();
  return contains(resourcesRoot, target) ? resolveResourceContext(resourcesRoot, target) : null;
}

function allowedExternalUrl(value: unknown): string {
  const raw = requireString(value, "URL", 4096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid external URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) external URLs are allowed.");
  return url.toString();
}

function scopedTxDataPath(value: unknown): string {
  const requested = requireString(value, "txData path");
  const current = loadConfig().txDataPath;
  if (requested !== current && requested !== pendingTxDataPath) {
    throw new Error("Choose the txData folder using Browse before accessing it.");
  }
  return requested;
}

function requireCfxTarget(value: unknown): CfxTarget {
  if (value !== "legacy" && value !== "enhanced" && value !== "redm") {
    throw new Error("Cfx.re target must be FiveM Legacy, FiveM Enhanced, or RedM.");
  }
  return value;
}

function cfxTargetLabel(target: CfxTarget): string {
  if (target === "legacy") return "FiveM Legacy";
  if (target === "enhanced") return "FiveM Enhanced";
  return "RedM";
}

function clientExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFivemExePath;
  if (target === "enhanced") return config.enhancedFivemExePath;
  return config.redmClientExePath;
}

function serverExeFor(config: StudioConfig, target: CfxTarget): string | null {
  if (target === "legacy") return config.legacyFxServerExePath;
  if (target === "enhanced") return config.enhancedFxServerExePath;
  return config.redmFxServerExePath;
}

function scopedClientExe(value: unknown, target: CfxTarget): string | null {
  if (value === null || value === undefined || value === "") return null;
  const requested = requireString(value, `${cfxTargetLabel(target)} executable`);
  const current = clientExeFor(loadConfig(), target);
  if (requested !== current && requested !== pendingClientExePaths[target]) {
    throw new Error(`Choose the ${cfxTargetLabel(target)} client executable using Browse before saving it.`);
  }
  return requested;
}

function scopedFxServerExe(value: unknown, target: CfxTarget, txDataPath?: string | null): string | null {
  if (value === null || value === undefined || value === "") return null;
  const requested = requireString(value, "Local server executable");
  const current = serverExeFor(loadConfig(), target);
  if (requested !== current && requested !== pendingFxServerExePaths[target]) {
    throw new Error(`Choose the ${cfxTargetLabel(target)} local server executable using Browse before saving it.`);
  }
  const artifact = resolveArtifactTarget(requested, txDataPath);
  const expectedFlavor = target === "enhanced" ? "enhanced" : "legacy";
  if (artifact.flavor !== expectedFlavor) {
    throw new Error(
      target === "enhanced"
        ? "The FiveM Enhanced server path must point to cfx-server.exe."
        : `The ${cfxTargetLabel(target)} server path must point to FXServer.exe.`,
    );
  }
  return requested;
}

function requireArtifactTrack(value: unknown): ArtifactTrack {
  if (value !== "recommended" && value !== "latest") throw new Error("Artifact track must be recommended or latest.");
  return value;
}

function artifactStatePath(target: CfxTarget): string {
  return path.join(app.getPath("userData"), `artifact-install-${target}.json`);
}

function recentWorkspacesPath(): string {
  return path.join(app.getPath("userData"), "recent-workspaces.json");
}

function resolvedSystemTheme(): "dark" | "light" {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function requireThemePackStore(): ThemePackStore {
  if (!themePackStore) throw new Error("Theme packs are not ready yet.");
  return themePackStore;
}

function applyNativeTheme(theme: ThemePreference): void {
  const base = themeBaseForPreference(theme, requireThemePackStore());
  nativeTheme.themeSource = base === "system" ? "system" : base === "light" ? "light" : "dark";
  const resolved = base === "system" ? resolvedSystemTheme() : base;
  mainWindow?.setBackgroundColor(resolved === "light" ? "#F7F5F2" : "#101317");
  consoleWindow?.setBackgroundColor(resolved === "light" ? "#F7F5F2" : "#101317");
}

function createWindow() {
  const startupConfig = loadConfig();
  const configuredTheme = startupConfig.theme;
  const configuredBase = themeBaseForPreference(configuredTheme, requireThemePackStore());
  const windowTheme = configuredBase === "system" ? resolvedSystemTheme() : configuredBase;
  const statePath = path.join(app.getPath("userData"), "window-state.json");
  const storedState = loadWindowState(statePath, screen.getAllDisplays().map((display) => display.workArea));
  mainWindow = new BrowserWindow({
    x: storedState.x,
    y: storedState.y,
    width: storedState.width,
    height: storedState.height,
    minWidth: 1024,
    minHeight: 640,
    title: "QB Studio",
    backgroundColor: windowTheme === "light" ? "#F7F5F2" : "#101317",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setZoomFactor(startupConfig.uiScale);
  if (storedState.maximized) mainWindow.maximize();

  let windowStateTimer: ReturnType<typeof setTimeout> | null = null;
  const persistWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getNormalBounds();
    try {
      saveWindowState(statePath, { ...bounds, maximized: mainWindow.isMaximized() });
    } catch {
      // Window-state persistence must never block use or shutdown.
    }
  };
  const queueWindowState = () => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(persistWindowState, 250);
  };
  mainWindow.on("resize", queueWindowState);
  mainWindow.on("move", queueWindowState);
  mainWindow.on("maximize", queueWindowState);
  mainWindow.on("unmaximize", queueWindowState);

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  const allowedNavigation = (target: string) => {
    if (devUrl) {
      try {
        return new URL(target).origin === new URL(devUrl).origin;
      } catch {
        return false;
      }
    }
    return target === mainWindow?.webContents.getURL();
  };
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Only pop the DevTools window open when explicitly asked for (OPEN_DEVTOOLS=1) -
  // running via `npm run dev` / start.bat should look like a normal app, not a
  // developer build. Ctrl+Shift+I still works on demand (bound below) since removing
  // the default menu below takes that binding away otherwise.
  if (process.env.OPEN_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.control && input.shift && input.key.toUpperCase() === "I") {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // Re-focus the embedded FiveM window whenever Studio itself regains OS focus (e.g. alt-tabbing
  // back from another app) — GTA5 pauses/blanks its rendering while unfocused, and a plain window
  // activation like this doesn't otherwise reach a reparented child window belonging to another process.
  mainWindow.on("focus", () => windowEmbed.onHostFocusGained());

  mainWindow.on("close", (event) => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    persistWindowState();
    if (allowCloseWithUnsavedChanges || dirtyFileCount === 0 || !mainWindow) return;
    event.preventDefault();
    const plural = dirtyFileCount === 1 ? "file has" : "files have";
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["Discard changes and close", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: `${dirtyFileCount} ${plural} unsaved changes.`,
      detail: "Closing QB Studio now will discard them.",
    });
    if (choice === 0) {
      allowCloseWithUnsavedChanges = true;
      mainWindow.close();
    }
  });

  mainWindow.on("closed", () => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.close();
    mainWindow = null;
  });
}

function openConsoleWindow(): void {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    if (consoleWindow.isMinimized()) consoleWindow.restore();
    consoleWindow.show();
    consoleWindow.focus();
    return;
  }
  const startupConfig = loadConfig();
  const configuredBase = themeBaseForPreference(startupConfig.theme, requireThemePackStore());
  const windowTheme = configuredBase === "system" ? resolvedSystemTheme() : configuredBase;
  consoleWindow = new BrowserWindow({
    width: 980,
    height: 620,
    minWidth: 640,
    minHeight: 360,
    title: "QB Studio Console",
    backgroundColor: windowTheme === "light" ? "#F7F5F2" : "#101317",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  consoleWindow.webContents.setZoomFactor(startupConfig.uiScale);
  consoleWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    consoleWindow?.setTitle("QB Studio Console");
  });
  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    const target = new URL(devUrl);
    target.searchParams.set("view", "console");
    void consoleWindow.loadURL(target.toString());
  } else {
    void consoleWindow.loadFile(path.join(__dirname, "../dist/index.html"), { query: { view: "console" } });
  }
  consoleWindow.once("ready-to-show", () => consoleWindow?.show());
  const allowedNavigation = (target: string) => {
    try {
      return devUrl
        ? new URL(target).origin === new URL(devUrl).origin
        : target === consoleWindow?.webContents.getURL();
    } catch {
      return false;
    }
  };
  consoleWindow.webContents.on("will-navigate", (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault();
  });
  consoleWindow.webContents.on("will-redirect", (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault();
  });
  consoleWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  consoleWindow.on("closed", () => { consoleWindow = null; });
}

// Tell the renderer when the MCP transport drops on its own, so the status pill
// doesn't sit on a stale "Connected" until the next tool call fails.
setOnDropped(() => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mcp:dropped");
});

// When the agent edits a file, tell the renderer so an open editor buffer doesn't
// go stale — otherwise the user's next Ctrl+S silently reverts the agent's work.
setOnFileWritten((absolutePath) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("project:fileWritten", absolutePath);
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  // The default File/Edit/View/Window/Help menu is generic Electron boilerplate —
  // Studio has its own branded toolbar (TopBar) providing the equivalent actions,
  // so the native menu bar is just redundant chrome sitting above it.
  Menu.setApplicationMenu(null);

  try {
    recoverConfigTransaction();
  } catch (error) {
    dialog.showErrorBox(
      "QB Studio could not recover settings",
      `An interrupted settings save could not be recovered safely. No configuration was loaded. ${error instanceof Error ? error.message : String(error)}`,
    );
    app.quit();
    return;
  }

  const startupConfig = loadConfig();
  themePackStore = new ThemePackStore(path.join(app.getPath("userData"), "themes"));
  try { recordRecentWorkspace(recentWorkspacesPath(), startupConfig); } catch { /* non-critical app history */ }
  applyNativeTheme(startupConfig.theme);
  nativeTheme.on("updated", () => {
    const systemTheme = resolvedSystemTheme();
    const activeTheme = previewThemePreference ?? loadConfig().theme;
    if (themeBaseForPreference(activeTheme, requireThemePackStore()) === "system") {
      mainWindow?.setBackgroundColor(systemTheme === "light" ? "#F7F5F2" : "#101317");
      consoleWindow?.setBackgroundColor(systemTheme === "light" ? "#F7F5F2" : "#101317");
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("theme:systemChanged", systemTheme);
    if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.webContents.send("theme:systemChanged", systemTheme);
  });
  const recoveryNotices: string[] = [];
  for (const target of CFX_TARGETS) {
    const executable = serverExeFor(startupConfig, target);
    if (!executable) continue;
    try {
      const notice = recoverInterruptedArtifactUpdate(executable, artifactStatePath(target));
      if (notice) recoveryNotices.push(`${cfxTargetLabel(target)}: ${notice}`);
    } catch (error) {
      recoveryNotices.push(`${cfxTargetLabel(target)} artifact recovery needs attention: ${(error as Error).message}`);
    }
  }
  artifactRecoveryNotice = recoveryNotices.length > 0 ? recoveryNotices.join(" ") : null;

  revertStore = new RevertStore(path.join(app.getPath("userData"), "revert-store"));
  setProjectRevertStore(revertStore);
  workspaceSearch = new WorkspaceSearchService(revertStore);
  bookmarkStore = new BookmarkStore(path.join(app.getPath("userData"), "bookmarks"));
  appUpdateController = new AppUpdateController(
    autoUpdater,
    app.getVersion(),
    app.isPackaged,
    broadcastAppUpdateState,
  );

  registerIpcHandlers();
  createWindow();
  discordPresence.update(startupConfig.discordPresenceEnabled, startupConfig.activeCfxTarget, app.getVersion());

  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});

app.on("window-all-closed", () => {
  agent.cancelTurn();
  mcpDisconnect();
  stopWatching();
  windowEmbed.detach();
  stopManagedRuntime();
  luaLanguageServer.stop();
  discordPresence.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => discordPresence.stop());

function registerIpcHandlers() {
  // --- config ---
  ipcMain.handle("config:get", (event) => {
    requireStudioWindowSender(event);
    return loadConfig();
  });
  ipcMain.handle("console:openPopout", () => openConsoleWindow());
  ipcMain.handle("console:clearView", () => clearConsoleViews());
  ipcMain.handle("console:openSourceLocation", async (event, request: unknown) => {
    requireStudioWindowSender(event);
    const profileRoot = activeProfileRoot();
    const resourcesRoot = activeResourcesRoot();
    const location = await resolveConsoleSourceLocation(profileRoot, resourcesRoot, request);
    if (path.relative(activeProfileRoot(), profileRoot) !== "") {
      throw new Error("The selected workspace changed while resolving that console source.");
    }
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("The main QB Studio window is unavailable.");
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("console:revealSourceLocation", location);
    return location;
  });
  ipcMain.handle("console:requestAgentFix", async (event, request: unknown, diagnosticLine: unknown) => {
    requireStudioWindowSender(event);
    const promptConfig = loadConfig();
    const workspaceScope = agentPromptWorkspaceScope(promptConfig.txDataPath, promptConfig.selectedProfile);
    const promptAgentScope = agentRuntimeSignature(promptConfig);
    const profileRoot = activeProfileRoot();
    const resourcesRoot = activeResourcesRoot();
    const prepared = await prepareConsoleAgentFix(profileRoot, resourcesRoot, request, diagnosticLine);
    const currentConfig = loadConfig();
    if (path.relative(activeProfileRoot(), profileRoot) !== "" ||
        agentPromptWorkspaceScope(currentConfig.txDataPath, currentConfig.selectedProfile) !== workspaceScope ||
        agentRuntimeSignature(currentConfig) !== promptAgentScope) {
      throw new Error("The selected workspace or agent changed while preparing that console diagnostic.");
    }
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("The main QB Studio window is unavailable.");
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("console:agentFixPrompt", prepared.prompt, workspaceScope, promptAgentScope);
  });
  ipcMain.handle("console:clearGeneration", () => consoleClearGeneration);
  ipcMain.handle("console:setRefreshInterval", (_e, value: unknown) =>
    serverOperation.run("the console refresh interval change", () => {
      const interval = requireFiniteNumber(value, "Console refresh interval");
      if (![0, 1_000, 2_000, 5_000, 10_000, 30_000].includes(interval)) throw new Error("Unsupported console refresh interval.");
      const saved = saveConfig({ ...loadConfig(), consoleRefreshIntervalMs: interval });
      for (const window of [mainWindow, consoleWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send("console:refreshIntervalChanged", saved.consoleRefreshIntervalMs);
      }
      return saved.consoleRefreshIntervalMs;
    }),
  );
  ipcMain.handle("config:set", (event, config: unknown, credentialUpdatesValue?: unknown) => {
    requireMainWindowSender(event);
    return serverOperation.run("the Settings change", async () => {
      if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("Configuration must be an object.");
      const candidate = config as Record<string, unknown>;
      const previous = loadConfig();
      const requestedAgent = requireAgentSettingsUpdate(candidate.agent, previous.agent.credentialRevision);
      const switchingProfile =
        candidate.txDataPath !== previous.txDataPath || candidate.selectedProfile !== previous.selectedProfile;
      if (candidate.txDataPath !== null && candidate.txDataPath !== undefined) scopedTxDataPath(candidate.txDataPath);
      if (typeof candidate.theme === "string" && candidate.theme.startsWith("custom:")) {
        const themeId = customThemeId(candidate.theme as ThemePreference);
        if (!themeId || !requireThemePackStore().find(themeId)) throw new Error("Install that custom theme before saving it.");
      }
      requireCfxTarget(candidate.activeCfxTarget);
      scopedClientExe(candidate.legacyFivemExePath, "legacy");
      scopedClientExe(candidate.enhancedFivemExePath, "enhanced");
      scopedClientExe(candidate.redmClientExePath, "redm");
      const txDataPath = typeof candidate.txDataPath === "string" ? candidate.txDataPath : null;
      scopedFxServerExe(candidate.legacyFxServerExePath, "legacy", txDataPath);
      scopedFxServerExe(candidate.enhancedFxServerExePath, "enhanced", txDataPath);
      scopedFxServerExe(candidate.redmFxServerExePath, "redm", txDataPath);
      // Console refresh is edited by the console itself, not by Settings. Read
      // its latest persisted value inside the same operation lock so a stale,
      // hidden renderer draft cannot overwrite it. Credential revisions are
      // likewise main-owned and can change while Settings is open.
      const requested = {
        ...candidate,
        agent: requestedAgent,
        consoleRefreshIntervalMs: previous.consoleRefreshIntervalMs,
      };
      let normalizedRequested = normalizeConfig(requested);
      const credentialUpdates = requireAgentCredentialUpdates(credentialUpdatesValue, normalizedRequested.agent);
      if (credentialUpdates.some((update) => update.connectionId === normalizedRequested.agent.active.connectionId)) {
        normalizedRequested = withCredentialRevision(
          normalizedRequested,
          normalizedRequested.agent.active.connectionId,
        );
      }
      const switchingAgent = agentRuntimeSignature(previous) !== agentRuntimeSignature(normalizedRequested);
      if (switchingAgent && agent.isRunning()) {
        throw new Error("Stop the current agent response before changing its connection or model.");
      }
      const saved = saveConfigWithConnectionKeys(normalizedRequested, credentialUpdates);
      if (switchingProfile) {
        invalidateConsoleSourceIndex();
        clearConsoleViews();
        agent.resetConversation();
        await mcpDisconnect();
        stopManagedRuntime();
        luaLanguageServer.stop();
      } else if (switchingAgent) {
        agent.resetConversation();
      }
      previewThemePreference = null;
      try { recordRecentWorkspace(recentWorkspacesPath(), saved); } catch { /* non-critical app history */ }
      applyNativeTheme(saved.theme);
      discordPresence.update(saved.discordPresenceEnabled, saved.activeCfxTarget, app.getVersion());
      mainWindow?.webContents.setZoomFactor(saved.uiScale);
      consoleWindow?.webContents.setZoomFactor(saved.uiScale);
      broadcastConfig(saved);
      return saved;
    });
  });
  ipcMain.handle("theme:system", () => resolvedSystemTheme());
  ipcMain.handle("theme:listPacks", () => requireThemePackStore().list());
  ipcMain.handle("theme:preview", (_e, preferenceValue: unknown) => {
    const preference = requireString(preferenceValue, "Theme preference", 64) as ThemePreference;
    const id = customThemeId(preference);
    if (!id && preference !== "system" && preference !== "dark" && preference !== "light" && preference !== "high-contrast") {
      throw new Error("Unsupported theme preference.");
    }
    if (preference.startsWith("custom:") && (!id || !requireThemePackStore().find(id))) {
      throw new Error("That custom theme is no longer installed.");
    }
    previewThemePreference = preference;
    applyNativeTheme(preference);
  });
  ipcMain.handle("theme:clearPreview", () => {
    previewThemePreference = null;
    applyNativeTheme(loadConfig().theme);
  });
  ipcMain.handle("theme:importPack", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "QB Studio theme pack", extensions: ["json"] }],
    });
    if (result.canceled) return null;
    return requireThemePackStore().import(result.filePaths[0]);
  });
  ipcMain.handle("theme:openPackFolder", async () => {
    const directory = requireThemePackStore().directory();
    fs.mkdirSync(directory, { recursive: true });
    await shell.openPath(directory);
  });
  ipcMain.handle("recents:list", () => listRecentWorkspaces(recentWorkspacesPath()));
  ipcMain.handle("recents:select", async (_e, idValue: unknown, allowDiscard: unknown) => {
    if (dirtyFileCount > 0 && allowDiscard !== true) throw new Error("Save or explicitly discard open editor changes before switching workspaces.");
    const id = requireString(idValue, "Recent workspace id", 24);
    const recent = resolveRecentWorkspace(recentWorkspacesPath(), id);
    invalidateConsoleSourceIndex();
    clearConsoleViews();
    agent.resetConversation();
    await mcpDisconnect();
    stopManagedRuntime();
    luaLanguageServer.stop();
    const saved = saveConfig({
      ...loadConfig(),
      txDataPath: recent.txDataPath,
      selectedProfile: recent.profile,
      activeCfxTarget: recent.target,
    });
    try { recordRecentWorkspace(recentWorkspacesPath(), saved); } catch { /* non-critical app history */ }
    return saved;
  });

  // --- conventional local client discovery and setup diagnostics ---
  ipcMain.handle("installs:detectClients", () => {
    const localAppData = process.env.LOCALAPPDATA;
    const detected = localAppData && path.isAbsolute(localAppData)
      ? detectConventionalClientInstalls(localAppData)
      : { legacy: null, enhanced: null, redm: null };
    for (const target of CFX_TARGETS) {
      if (detected[target]) pendingClientExePaths[target] = detected[target];
    }
    return detected;
  });
  ipcMain.handle("installs:detectAll", (_e, txDataValue: unknown) => {
    const config = loadConfig();
    const txDataPath = txDataValue === null || txDataValue === undefined || txDataValue === ""
      ? config.txDataPath
      : scopedTxDataPath(txDataValue);
    const detected = detectConventionalExecutables({
      localAppData: process.env.LOCALAPPDATA,
      userProfile: process.env.USERPROFILE,
      txDataPath,
      artifactStatePaths: Object.fromEntries(CFX_TARGETS.map((target) => [target, artifactStatePath(target)])),
    });
    for (const target of CFX_TARGETS) {
      if (detected.clients[target]) pendingClientExePaths[target] = detected.clients[target];
      if (detected.servers[target]) pendingFxServerExePaths[target] = detected.servers[target];
    }
    return detected;
  });

  ipcMain.handle(
    "setup:diagnostics",
    (_e, txDataValue: unknown, profileValue: unknown, targetValue: unknown, clientValue: unknown, serverValue: unknown) => {
      const target = requireCfxTarget(targetValue);
      let txDataRoot = false;
      let workspace = false;
      let txAdminAttachment = false;
      let rconCapability = false;
      let txDataPath: string | null = null;
      let profileRoot: string | null = null;
      try {
        if (txDataValue) {
          txDataPath = scopedTxDataPath(txDataValue);
          const stat = fs.lstatSync(txDataPath);
          txDataRoot = stat.isDirectory() && !stat.isSymbolicLink();
        }
        if (txDataRoot && profileValue) {
          ({ profileRoot } = selectedProfileRoot(txDataPath, profileValue));
          const resolved = resolveProfile(txDataPath!, path.basename(profileRoot));
          workspace = Boolean(resolved.serverCfgPath && resolved.resourcesPath);
        }
        if (workspace && txDataPath && profileRoot) {
          txAdminAttachment = discoverTxAdminControlProfile(txDataPath, profileRoot) !== null;
          const parsed = parseLocalServerConfig(loadLocalServerConfig(profileRoot));
          rconCapability = Boolean(parsed.rconPassword);
        }
      } catch {
        // Individual false checks below are actionable; setup remains usable.
      }

      let clientExecutable = false;
      let serverExecutable = false;
      try { clientExecutable = isRegularUnlinkedFile(scopedClientExe(clientValue, target)); } catch { /* untrusted/stale draft */ }
      try { serverExecutable = isRegularUnlinkedFile(scopedFxServerExe(serverValue, target, txDataPath)); } catch { /* untrusted/stale draft */ }
      const git = (() => {
        try {
          const result = spawnSync("git", ["--version"], { shell: false, windowsHide: true, encoding: "utf8", timeout: 2_000 });
          return result.status === 0 && /^git version\s+/i.test(result.stdout.trim());
        } catch {
          return false;
        }
      })();

      return { txDataRoot, workspace, serverExecutable, clientExecutable, txAdminAttachment, rconCapability, git };
    },
  );

  // --- bounded programmatic-write undo history ---
  ipcMain.handle("revert:list", () => requireRevertStore().listBatches(activeResourcesRoot()));
  ipcMain.handle("revert:apply", (_e, batchId: unknown, mode: unknown) => {
    const result = requireRevertStore().revertBatch(
      activeResourcesRoot(),
      requireString(batchId, "Undo batch id", 128),
      requireRevertMode(mode),
    );
    for (const relativePath of result.reverted) {
      const absolutePath = resolveInsideRoot(activeResourcesRoot(), relativePath);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("project:fileWritten", absolutePath);
    }
    return result;
  });

  // --- human-facing, resource-scoped search and revision-safe replace ---
  ipcMain.handle("search:run", (_e, request: unknown) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Search request must be an object.");
    const raw = request as Record<string, unknown>;
    const workspaceRoot = activeResourcesRoot();
    let scopeRoot = workspaceRoot;
    if (raw.scope === "resource") {
      const requestedRoot = requireString(raw.resourceRoot, "Resource root");
      const contained = resolveInsideRoot(workspaceRoot, path.relative(workspaceRoot, requestedRoot));
      const resource = resourceAtDirectory(workspaceRoot, contained);
      if (!resource || resource.rootPath !== contained) throw new Error("Choose an active resource before using resource-scoped search.");
      scopeRoot = resource.rootPath;
    } else if (raw.scope !== "workspace") {
      throw new Error("Search scope must be the active resource or the whole workspace.");
    }
    return requireWorkspaceSearch().search(workspaceRoot, scopeRoot, raw);
  });
  ipcMain.handle("search:previewReplace", (_e, searchId: unknown, selectedIds: unknown, replacement: unknown) =>
    requireWorkspaceSearch().preview(
      activeResourcesRoot(),
      requireString(searchId, "Search id", 128),
      selectedIds,
      replacement,
    ),
  );
  ipcMain.handle("search:applyReplace", (_e, applyToken: unknown) => {
    const result = requireWorkspaceSearch().apply(
      activeResourcesRoot(),
      requireString(applyToken, "Replacement preview token", 128),
    );
    for (const absolutePath of result.changedPaths) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("project:fileWritten", absolutePath);
    }
    return result;
  });

  // --- filesystem / resource tree ---
  ipcMain.handle("fs:listDir", (_e, dirPath: unknown) => listProfileDirectory(dirPath));
  ipcMain.handle("fs:readFile", (_e, filePath: unknown) => readTextFileSnapshot(scopedProfilePath(filePath)));
  ipcMain.handle("fs:writeFile", (_e, filePath: unknown, content: unknown, expectedRevision: unknown) =>
    writeTextFile(
      scopedProfilePath(filePath),
      requireString(content, "File content", 8 * 1024 * 1024),
      requireString(expectedRevision, "Expected file revision", 128),
    ),
  );
  ipcMain.handle("fs:rename", (_e, oldPath: unknown, newName: unknown) => {
    const oldTarget = scopedProfilePath(oldPath);
    const resourcesRoot = activeResourcesRoot();
    const name = assertSafeBasename(requireString(newName, "New name", 255));
    const newTarget = resolveInsideRoot(path.dirname(oldTarget), name);
    // Parent remains in the active profile root; resolve again to catch links.
    resolveInsideRoot(activeProfileRoot(), path.relative(activeProfileRoot(), newTarget));
    const rollbackBookmarks = bookmarkStore?.remapPathWithRollback(activeProfileRoot(), oldTarget, newTarget);
    try {
      const renamed = renamePath(oldTarget, name);
      if (contains(resourcesRoot, oldTarget) || contains(resourcesRoot, renamed)) {
        invalidateConsoleSourceIndex(resourcesRoot);
      }
      return renamed;
    } catch (error) {
      try { rollbackBookmarks?.(); } catch (rollbackError) {
        throw new Error(`Rename failed and bookmark rollback also failed: ${(error as Error).message}; ${(rollbackError as Error).message}`);
      }
      throw error;
    }
  });
  ipcMain.handle("fs:delete", async (_e, targetPath: unknown) => {
    const target = scopedProfilePath(targetPath);
    const resourcesRoot = activeResourcesRoot();
    const rollbackBookmarks = bookmarkStore?.removePathWithRollback(activeProfileRoot(), target);
    try {
      await shell.trashItem(target);
      if (contains(resourcesRoot, target)) invalidateConsoleSourceIndex(resourcesRoot);
    } catch (error) {
      try { rollbackBookmarks?.(); } catch (rollbackError) {
        throw new Error(`Delete failed and bookmark rollback also failed: ${(error as Error).message}; ${(rollbackError as Error).message}`);
      }
      throw error;
    }
  });
  ipcMain.handle("fs:watchRoot", (_e, _dirPath: unknown) => {
    if (!mainWindow) return;
    try {
      watchPath(activeProfileRoot(), mainWindow);
    } catch {
      stopWatching();
    }
  });

  // --- txData / server profile discovery ---
  ipcMain.handle("txdata:listProfiles", (_e, txDataPath: unknown) => listProfiles(scopedTxDataPath(txDataPath)));
  ipcMain.handle("txdata:resolveProfile", (_e, txDataPath: unknown, profile: unknown) =>
    resolveProfile(scopedTxDataPath(txDataPath), assertSafeBasename(requireString(profile, "Profile", 255))),
  );
  ipcMain.handle("txdata:createLocalWorkspace", (_e, txDataPath: unknown, name: unknown, port: unknown, target: unknown) =>
    createLocalWorkspace(
      scopedTxDataPath(txDataPath),
      requireString(name, "Workspace name", 255),
      requireFiniteNumber(port, "Local server port"),
      requireCfxTarget(target),
    ),
  );
  ipcMain.handle("txdata:previewDevelopmentRcon", (_e, txDataPath: unknown, profile: unknown) => {
    const selected = selectedProfileRoot(txDataPath, profile);
    return previewDevelopmentRcon(selected.profileRoot, workspaceHasRconPassword(selected.profileRoot));
  });
  ipcMain.handle("txdata:applyDevelopmentRcon", (_e, txDataPath: unknown, profile: unknown, allowOverwrite: unknown) =>
    serverOperation.run("local RCON setup", async () => {
      if (typeof allowOverwrite !== "boolean") throw new Error("RCON replacement confirmation must be a boolean.");
      const selected = selectedProfileRoot(txDataPath, profile);
      const hasExistingPassword = workspaceHasRconPassword(selected.profileRoot);
      const result = applyDevelopmentRcon(selected.profileRoot, hasExistingPassword, allowOverwrite);
      try { await mcpDisconnect(); } catch { /* the on-disk setup succeeded; a stale runtime is stopped below */ }
      stopManagedRuntime();
      return result;
    }),
  );

  ipcMain.handle("dialog:chooseFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled) return null;
    pendingTxDataPath = result.filePaths[0];
    return pendingTxDataPath;
  });

  ipcMain.handle("dialog:chooseExe", async (_e, targetValue: unknown) => {
    const target = requireCfxTarget(targetValue);
    const filters =
      process.platform === "win32" ? [{ name: "Executable", extensions: ["exe"] }] : [{ name: "All files", extensions: ["*"] }];
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    const expectedName = target === "redm" ? "redm.exe" : "fivem.exe";
    if (process.platform === "win32" && path.basename(selected).toLowerCase() !== expectedName) {
      throw new Error(`Choose ${target === "redm" ? "RedM.exe" : "FiveM.exe"} for ${cfxTargetLabel(target)}.`);
    }
    pendingClientExePaths[target] = selected;
    return pendingClientExePaths[target];
  });

  ipcMain.handle("dialog:chooseFxServerExe", async (_e, targetValue: unknown) => {
    const target = requireCfxTarget(targetValue);
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Cfx.re server executable", extensions: ["exe"] }],
    });
    if (result.canceled) return null;
    const artifactTarget = resolveArtifactTarget(result.filePaths[0], null);
    const expectedFlavor = target === "enhanced" ? "enhanced" : "legacy";
    if (artifactTarget.flavor !== expectedFlavor) {
      throw new Error(
        target === "enhanced"
          ? "Choose cfx-server.exe for the FiveM Enhanced server."
          : `Choose FXServer.exe for the ${cfxTargetLabel(target)} server.`,
      );
    }
    pendingFxServerExePaths[target] = result.filePaths[0];
    return pendingFxServerExePaths[target];
  });

  // --- bundled coding runtime ---
  ipcMain.handle("mcp:connect", async () => {
    const managed = await ensureManagedRuntime(loadConfig());
    return mcpConnect(managed.url, managed.token, managed.serverIdentity);
  });
  ipcMain.handle("mcp:disconnect", () => mcpDisconnect());
  ipcMain.handle("mcp:status", () => ({
    connected: mcpIsConnected(),
    url: mcpConnectedUrl(),
    runtimeIdentity: mcpRuntimeIdentity(),
    workspaceMatch: mcpRuntimeWorkspaceMatch(),
  }));
  ipcMain.handle("mcp:callTool", (_e, name: unknown, args: unknown) => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
    const toolName = requireString(name, "Tool name", 256);
    if (!RENDERER_MCP_TOOLS.has(toolName)) throw new Error(`The QB Studio UI is not allowed to invoke ${toolName}.`);
    return mcpCallTool(toolName, args as Record<string, unknown>);
  });
  ipcMain.handle("resources:listStatuses", () => mcpListResourceStatuses());
  ipcMain.handle("resources:context", (_e, filePath: unknown) => activeResourceContext(filePath));
  ipcMain.handle("resources:dependencyGraph", () => buildResourceDependencyGraph(activeResourcesRoot()));
  ipcMain.handle("resources:compare", (_e, leftRoot: unknown, rightRoot: unknown) => compareResources(
    activeResourcesRoot(),
    requireString(leftRoot, "Left resource path"),
    requireString(rightRoot, "Right resource path"),
  ));
  ipcMain.handle("resources:duplicate", (_e, sourceRoot: unknown, newName: unknown) => {
    const resourcesRoot = activeResourcesRoot();
    const result = duplicateResource(
      resourcesRoot,
      requireString(sourceRoot, "Source resource path"),
      requireString(newName, "New resource name", 255),
    );
    invalidateConsoleSourceIndex(resourcesRoot);
    return result;
  });
  ipcMain.handle("resources:createFile", (_e, parentPath: unknown, name: unknown) => createResourceFile(
    activeResourcesRoot(),
    requireString(parentPath, "Parent folder"),
    requireString(name, "New file name", 255),
  ));
  ipcMain.handle("resources:createDirectory", (_e, parentPath: unknown, name: unknown) => {
    const resourcesRoot = activeResourcesRoot();
    const result = createResourceDirectory(
      resourcesRoot,
      requireString(parentPath, "Parent folder"),
      requireString(name, "New folder name", 255),
    );
    invalidateConsoleSourceIndex(resourcesRoot);
    return result;
  });
  ipcMain.handle("resources:createStarter", (_e, parentPath: unknown, name: unknown, templateValue: unknown) => {
    const resourcesRoot = activeResourcesRoot();
    const result = createStarterResource(
      resourcesRoot,
      requireString(parentPath, "Parent folder"),
      requireString(name, "New resource name", 255),
      loadConfig().activeCfxTarget === "redm" ? "rdr3" : "gta5",
      requireStarterResourceTemplate(templateValue),
      starterTemplateCatalogRoot(),
    );
    invalidateConsoleSourceIndex(resourcesRoot);
    return result;
  });
  ipcMain.handle("resources:importFolder", (_e, sourceRoot: unknown) => {
    const resourcesRoot = activeResourcesRoot();
    const result = importResourceFolder(resourcesRoot, requireString(sourceRoot, "Dropped resource folder"));
    invalidateConsoleSourceIndex(resourcesRoot);
    return result;
  });
  ipcMain.handle("bookmarks:list", () => bookmarkStore?.list(activeProfileRoot()) ?? []);
  ipcMain.handle("bookmarks:toggle", (_e, filePath: unknown, line: unknown) => {
    if (!bookmarkStore) throw new Error("Bookmarks are not ready yet.");
    return bookmarkStore.toggle(
      activeProfileRoot(),
      scopedProfilePath(filePath),
      Math.floor(requireFiniteNumber(line, "Bookmark line")),
    );
  });

  // --- GitHub import ---
  ipcMain.handle("github:fetchRepoInfo", (_e, input: unknown) => fetchRepoInfo(requireString(input, "GitHub repository", 2048)));
  ipcMain.handle("github:searchRepos", (_e, input: unknown) => searchGithubRepos(requireString(input, "GitHub search", 128)));
  ipcMain.handle("github:listOrgRepos", (_e, input: unknown) =>
    listGithubOrganizationRepos(requireString(input, "GitHub organization", 128)),
  );
  ipcMain.handle("github:cloneRepo", async (_e, repoUrl: unknown, _projectRoot: unknown) => {
    const resourcesRoot = activeResourcesRoot();
    const result = await cloneRepo(requireString(repoUrl, "GitHub repository", 2048), resourcesRoot);
    invalidateConsoleSourceIndex(resourcesRoot);
    return result;
  });

  // --- launch the selected FiveM or RedM client, in its own window ---
  ipcMain.handle("cfx:launch", (_e, targetValue: unknown) => {
    const target = requireCfxTarget(targetValue);
    const configured = clientExeFor(loadConfig(), target);
    if (!configured) throw new Error(`Choose the ${cfxTargetLabel(target)} client executable in Settings first.`);
    if (process.platform === "win32" && path.extname(configured).toLowerCase() !== ".exe") {
      throw new Error("Cfx.re client executable must be an .exe file.");
    }
    spawn(configured, [], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, target };
  });

  // --- local Cfx.re server launch and artifact maintenance ---
  ipcMain.handle("server:status", async () => {
    const config = loadConfig();
    const ordered = [config.activeCfxTarget, ...CFX_TARGETS.filter((target) => target !== config.activeCfxTarget)];
    for (const target of ordered) {
      const executable = serverExeFor(config, target);
      if (!executable) continue;
      const artifact = resolveArtifactTarget(executable, config.txDataPath);
      const pids = await findRunningServerPids(artifact.executablePath);
      if (pids.length > 0) return { running: true, pids, target };
    }
    return { running: false, pids: [], target: config.activeCfxTarget };
  });

  ipcMain.handle("server:crashReport", () => newestCrashReport(activeProfileRoot()));
  ipcMain.handle("server:notifyUnexpectedExit", (_e, targetValue: unknown) => {
    const target = requireCfxTarget(targetValue);
    if (!loadConfig().notifyOnServerExit || mainWindow?.isFocused() || !Notification.isSupported()) {
      return { shown: false };
    }
    new Notification({
      title: "QB Studio",
      body: `${cfxTargetLabel(target)} FXServer stopped unexpectedly. Crash context is ready in the Console tab.`,
      silent: false,
    }).show();
    return { shown: true };
  });

  ipcMain.handle("server:launch", () =>
    serverOperation.run("the local server start", async () => {
      const config = loadConfig();
      const target = config.activeCfxTarget;
      const executable = serverExeFor(config, target);
      if (!executable) throw new Error(`Choose the ${cfxTargetLabel(target)} server executable in Settings first.`);
      if (!config.txDataPath || !config.selectedProfile) throw new Error("Choose a txData workspace in Settings first.");
      for (const otherTargetName of CFX_TARGETS) {
        if (otherTargetName === target) continue;
        const otherExecutable = serverExeFor(config, otherTargetName);
        if (!otherExecutable || path.resolve(otherExecutable).toLowerCase() === path.resolve(executable).toLowerCase()) continue;
        const otherTarget = resolveArtifactTarget(otherExecutable, config.txDataPath);
        const otherPids = await findRunningServerPids(otherTarget.executablePath);
        if (otherPids.length > 0) {
          throw new Error(
            `Stop the ${cfxTargetLabel(otherTargetName)} server before starting the ${cfxTargetLabel(target)} server on this workspace.`,
          );
        }
      }
      const workspaceRoot = activeProfileRoot();
      const controlProfile = discoverTxAdminControlProfile(config.txDataPath, workspaceRoot);
      const recoveryNotice = recoverInterruptedArtifactUpdate(executable, artifactStatePath(target));
      const selectedArtifact = resolveArtifactTarget(executable, config.txDataPath);
      const alreadyRunning = await findRunningServerPids(selectedArtifact.executablePath);
      if (alreadyRunning.length === 0) {
        const endpoint = parseLocalServerConfig(loadLocalServerConfig(workspaceRoot));
        await assertFxServerPortAvailable(endpoint.host, endpoint.port);
      }
      const launched = await launchLocalServer(executable, config.txDataPath, controlProfile);
      return { ...launched, target, recoveryNotice: recoveryNotice ?? undefined };
    }),
  );

  ipcMain.handle("server:stop", (_e, targetValue: unknown) =>
    serverOperation.run("the local server stop", async () => {
      const target = requireCfxTarget(targetValue);
      const config = loadConfig();
      const executable = serverExeFor(config, target);
      if (!executable) throw new Error(`Choose the ${cfxTargetLabel(target)} server executable in Settings first.`);
      return { ...(await stopLocalServer(executable, config.txDataPath)), target };
    }),
  );

  ipcMain.handle("artifacts:check", (_e, targetValue: unknown, track: unknown) =>
    serverOperation.run("the server artifact check", async () => {
      const target = requireCfxTarget(targetValue);
      const config = loadConfig();
      const executable = serverExeFor(config, target);
      if (!executable) throw new Error(`Choose and save the ${cfxTargetLabel(target)} server executable first.`);
      const selectedTrack = target === "enhanced" ? "recommended" : requireArtifactTrack(track);
      return checkArtifactUpdate(executable, config.txDataPath, selectedTrack, artifactStatePath(target));
    }),
  );

  ipcMain.handle("artifacts:update", (_e, targetValue: unknown, track: unknown) =>
    serverOperation.run("the server artifact update", async () => {
      const target = requireCfxTarget(targetValue);
      const config = loadConfig();
      const executable = serverExeFor(config, target);
      if (!executable) throw new Error(`Choose and save the ${cfxTargetLabel(target)} server executable first.`);
      const selectedTrack = target === "enhanced" ? "recommended" : requireArtifactTrack(track);
      return installArtifactUpdate(executable, config.txDataPath, selectedTrack, artifactStatePath(target), (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("artifacts:progress", { ...progress, target });
        }
      });
    }),
  );

  ipcMain.handle("artifacts:recoveryNotice", () => {
    const notice = artifactRecoveryNotice;
    artifactRecoveryNotice = null;
    return notice;
  });

  ipcMain.handle("app:setDirtyCount", (_e, count: unknown) => {
    const valid = requireFiniteNumber(count, "Dirty file count");
    dirtyFileCount = Math.max(0, Math.min(10000, Math.floor(valid)));
  });
  ipcMain.handle("app:setDiscordActivity", (_e, context: unknown) => {
    discordPresence.setContext(context);
  });
  ipcMain.handle("app:getUpdateState", (event) => {
    requireMainWindowSender(event);
    return requireAppUpdateController().snapshot();
  });
  ipcMain.handle("app:checkForUpdate", (event, manualValue: unknown = true) => {
    requireMainWindowSender(event);
    if (typeof manualValue !== "boolean") throw new Error("Manual update check must be a boolean.");
    return requireAppUpdateController().checkForUpdates(manualValue);
  });
  ipcMain.handle("app:downloadUpdate", (event) => {
    requireMainWindowSender(event);
    return requireAppUpdateController().downloadUpdate();
  });
  ipcMain.handle("app:restartToUpdate", (event) => {
    requireMainWindowSender(event);
    const updater = requireAppUpdateController();
    const updateState = updater.snapshot();
    const blockReason = appUpdateRestartBlockReason(updateState, dirtyFileCount);
    if (blockReason && updateState.phase !== "ready") throw new Error(blockReason);
    if (dirtyFileCount > 0) {
      const plural = dirtyFileCount === 1 ? "file has" : "files have";
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBoxSync(mainWindow, {
          type: "warning",
          buttons: ["OK"],
          defaultId: 0,
          title: "Save changes before updating",
          message: `${dirtyFileCount} ${plural} unsaved changes.`,
          detail: "Save or discard those editor changes, then choose Restart to update again.",
        });
      }
      return updater.snapshot();
    }
    allowCloseWithUnsavedChanges = true;
    try {
      const state = updater.restartToUpdate();
      if (state.phase === "error") allowCloseWithUnsavedChanges = false;
      return state;
    } catch (error) {
      allowCloseWithUnsavedChanges = false;
      throw error;
    }
  });
  ipcMain.handle("app:consumeWhatsNew", () => {
    try {
      return consumeWhatsNew(path.join(app.getPath("userData"), "last-seen-version.json"), app.getVersion(), app.isPackaged);
    } catch {
      return null;
    }
  });

  // --- on-demand Lua language intelligence ---
  // The executable is part of the verified application bundle. The renderer
  // only exchanges JSON-RPC messages with this one child process and cannot
  // choose an executable, workspace, environment, or command-line argument.
  ipcMain.handle("lua:start", () => {
    const config = loadConfig();
    const mode = config.editor.luaIntelligence;
    if (mode === "off") {
      luaLanguageServer.stop();
      return { ok: false as const, mode, error: "Lua intelligence is disabled in Settings." };
    }
    const workspaceRoot = activeProfileRoot();
    const runtimeRoot = app.isPackaged
      ? path.join(process.resourcesPath, "lua-language-server")
      : path.join(app.getAppPath(), "..", "vendor", "lua-language-server");
    const libraryRoot = app.isPackaged
      ? path.join(process.resourcesPath, "lua-library")
      : path.join(app.getAppPath(), "resources", "lua-library");
    const executable = path.join(runtimeRoot, "bin", "lua-language-server.exe");
    if (!fs.existsSync(executable)) {
      return { ok: false as const, mode, error: "The bundled Lua language server is missing. Reinstall QB Studio." };
    }
    if (!fs.existsSync(libraryRoot)) {
      return { ok: false as const, mode, error: "The bundled QBCore/Cfx definitions are missing. Reinstall QB Studio." };
    }
    const logPath = path.join(app.getPath("logs"), "lua-language-server");
    fs.mkdirSync(logPath, { recursive: true });
    luaLanguageServer.start(
      executable,
      workspaceRoot,
      logPath,
      (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lua:message", message);
      },
      (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lua:status", status);
      },
    );
    return { ok: true as const, mode, workspaceRoot, libraryRoot, version: "3.19.1" };
  });
  ipcMain.handle("lua:stop", () => luaLanguageServer.stop());
  ipcMain.on("lua:send", (event, value: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    try {
      luaLanguageServer.send(requireJsonRpcMessage(value));
    } catch (error) {
      mainWindow.webContents.send("lua:status", { state: "error", message: (error as Error).message });
    }
  });

  // --- agent chat ---
  // Credentials remain write-only. Every stored-key operation resolves an
  // opaque configured id main-side; the renderer cannot pair someone else's
  // saved key with a different endpoint.
  ipcMain.handle("agent:hasConnectionKey", (event, connectionId: unknown) => {
    requireMainWindowSender(event);
    return hasConnectionKey(requireAgentConnectionId(connectionId));
  });
  ipcMain.handle("agent:listConnectionModels", (event, connectionId: unknown) => {
    requireMainWindowSender(event);
    return agent.listConnectionModels(requireAgentConnectionId(connectionId));
  });
  ipcMain.handle("agent:probeModels", (event, connectionValue: unknown, keyOverrideValue?: unknown) => {
    requireMainWindowSender(event);
    const connection = requireAgentConnectionProbe(connectionValue);
    const keyOverride = keyOverrideValue === undefined ? "" : requireConnectionKey(keyOverrideValue);
    if (!connection.requiresKey && keyOverride) {
      throw new Error("A keyless connection cannot store or send an API key.");
    }
    return agent.probeModels(connection, keyOverride);
  });
  ipcMain.handle("agent:selectTarget", (event, connectionIdValue: unknown, modelValue: unknown) => {
    requireMainWindowSender(event);
    return serverOperation.run("the agent selection change", () => {
      const current = loadConfig();
      const selected = withAgentTarget(current, connectionIdValue, modelValue);
      if (selected === current) return current;
      if (agent.isRunning()) throw new Error("Stop the current agent response before switching agents.");
      const saved = saveConfig(selected);
      agent.resetConversation();
      broadcastConfig(saved);
      return saved;
    });
  });
  ipcMain.handle("agent:send", (event, message: unknown, expectedRuntimeScope: unknown) => {
    requireMainWindowSender(event);
    if (mainWindow) {
      return agent.sendMessage(
        mainWindow,
        requireString(message, "Message", 100000),
        requireString(expectedRuntimeScope, "Agent runtime scope", 4096),
      );
    }
  });
  ipcMain.handle("agent:cancel", (event) => {
    requireMainWindowSender(event);
    return agent.cancelTurn();
  });
  ipcMain.handle("agent:respondToApproval", (event, approvalId: unknown, approved: unknown) => {
    requireMainWindowSender(event);
    const resolved = resolveToolApproval(requireString(approvalId, "Approval id", 128), approved === true);
    if (!resolved) throw new Error("That approval request is no longer pending.");
    return { ok: true };
  });
  ipcMain.handle("agent:setEditorContext", (event, context: unknown) => {
    requireMainWindowSender(event);
    if (typeof context !== "object" || context === null) throw new Error("Editor context must be an object.");
    const value = context as EditorContext;
    setEditorContext(value);
  });
  ipcMain.handle("agent:reset", (event) => {
    requireMainWindowSender(event);
    if (agent.isRunning()) throw new Error("Stop the current agent response before starting a new chat.");
    return agent.resetConversation();
  });

  ipcMain.handle("shell:openExternal", (_e, url: unknown) => shell.openExternal(allowedExternalUrl(url)));
  ipcMain.handle("shell:showItemInFolder", (_e, targetPath: unknown) => shell.showItemInFolder(scopedProfilePath(targetPath)));
  ipcMain.handle("clipboard:writeText", (_e, value: unknown) => clipboard.writeText(requireString(value, "Clipboard text", 100_000)));

  // --- embed the live FiveM game window into the Viewport tab (Windows only) ---
  ipcMain.handle("windowEmbed:listCandidates", () => windowEmbed.listCandidates());
  ipcMain.handle("windowEmbed:attach", (_e, candidateId: unknown) =>
    mainWindow ? windowEmbed.attach(requireString(candidateId, "Window candidate id", 128), mainWindow) : { ok: false, error: "No main window" },
  );
  ipcMain.handle("windowEmbed:detach", () => windowEmbed.detach());
  ipcMain.handle("windowEmbed:setRect", (_e, x: unknown, y: unknown, width: unknown, height: unknown, visible: unknown) =>
    windowEmbed.setRect(
      requireFiniteNumber(x, "x"),
      requireFiniteNumber(y, "y"),
      Math.max(0, requireFiniteNumber(width, "width")),
      Math.max(0, requireFiniteNumber(height, "height")),
      visible === true,
    ),
  );
}
