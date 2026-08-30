export {};

export interface StudioConfig {
  txDataPath: string | null;
  selectedProfile: string | null;
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
  agentProvider: "anthropic" | "openai";
  openaiBaseUrl: string;
  openaiModel: string;
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

export interface EditorProblem {
  path: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  source?: string;
  code?: string;
}

export type AppUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  progressPercent: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  error: string | null;
}

export interface WhatsNewState {
  previousVersion: string;
  currentVersion: string;
}

export interface RecentWorkspaceSummary {
  id: string;
  label: string;
  target: CfxTarget;
  lastUsedAt: string;
}

export type CfxTarget = "legacy" | "enhanced" | "redm";
export type BuiltInThemePreference = "system" | "dark" | "light" | "high-contrast";
export type ThemePreference = BuiltInThemePreference | `custom:${string}`;
export type ThemeBase = Exclude<BuiltInThemePreference, "system">;
export type ResolvedTheme = ThemeBase | `custom:${string}`;

export interface ThemePack {
  schemaVersion: 1;
  id: string;
  name: string;
  author: string | null;
  base: ThemeBase;
  colors: Record<string, string>;
  editor: {
    colors: Record<string, string>;
    tokens: Record<string, string>;
  };
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  resourceName?: string;
}

export interface ResourceContext {
  name: string;
  rootPath: string;
  manifestPath: string;
}

export interface ResourceStatusItem {
  name: string;
  state: "started" | "stopped";
}

export interface ResourceStatusResult {
  resources: ResourceStatusItem[];
  serverStateAvailable: boolean;
}

export interface ResourceDependencyNode {
  name: string;
  rootPath: string;
  manifestPath: string;
  dependencies: string[];
  dependents: string[];
  missingDependencies: string[];
  manifestWarning?: string;
}

export interface ResourceDependencyGraph {
  nodes: ResourceDependencyNode[];
}

export interface ResourceComparisonFile {
  relativePath: string;
  kind: "added" | "removed" | "modified";
  originalContent: string;
  modifiedContent: string;
  previewUnavailable: boolean;
}

export interface ResourceComparison {
  leftName: string;
  rightName: string;
  files: ResourceComparisonFile[];
  totalChanged: number;
  scannedFiles: number;
  skippedCredentialFiles: number;
  truncated: boolean;
}

export interface ResourceDuplicateResult {
  name: string;
  rootPath: string;
  manifestPath: string;
  fileCount: number;
  skippedDirectories: string[];
}

export interface ResourceImportResult {
  name: string;
  rootPath: string;
  manifestPath: string;
  fileCount: number;
  skippedDirectories: string[];
}

export interface CreatedResourceEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface StarterResourceResult {
  name: string;
  rootPath: string;
  manifestPath: string;
  files: string[];
  fileCount: number;
  game: "gta5" | "rdr3";
  template: "lua" | "static-nui" | "react-nui" | "vue-nui";
}

export interface ConsoleSourceLocationRequest {
  kind: "resource" | "relative" | "profile" | "absolute";
  source: string;
  resourceName?: string;
  line: number;
  column: number;
}

export interface ResolvedConsoleSourceLocation {
  path: string;
  line: number;
  column: number;
}

export interface EditorBookmark {
  path: string;
  line: number;
  updatedAt: string;
}

export interface ProfileInfo {
  name: string;
  hasServerCfg: boolean;
  hasResources: boolean;
}

export interface ResolvedProfile {
  profileRoot: string;
  resourcesPath: string | null;
  serverCfgPath: string | null;
}

export interface LocalWorkspace {
  name: string;
  profileRoot: string;
  resourcesPath: string;
  serverCfgPath: string;
}

export interface EditorContext {
  path: string | null;
  selectedText: string;
  startLine: number;
  endLine: number;
}

export interface FileSnapshot {
  content: string;
  revision: string;
}

export interface RuntimeIdentity {
  contractVersion: string;
  mcp: { name: string; version: string };
  runtime: {
    serverData: { workspacePath: string; configPath: string };
    txAdmin: { dataDirectory: string | null; controlProfile: string | null };
    rcon: { host: string; port: number; configured: boolean };
  };
  capabilities: {
    console: boolean;
    resourceLifecycle: boolean;
  };
}

export interface RuntimeWorkspaceMatch {
  ok: boolean;
  reason?: string;
}

/** Mirrors TurnUsage in electron/providers/types.ts — one API response's tokens. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  contextWindow?: number;
  costUsd?: number;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | {
      type: "approval_request";
      approvalId: string;
      toolCallId: string;
      name: string;
      input: unknown;
      risk: "write" | "dangerous";
      summary: string;
      filePreview?: AgentFilePreview;
      previewError?: string;
    }
  | { type: "approval_resolved"; approvalId: string; approved: boolean; reason?: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "done" }
  | { type: "error"; message: string };

export interface AgentFilePreview {
  path: string;
  originalContent: string;
  modifiedContent: string;
  originalLabel: string;
  modifiedLabel: string;
  warning?: string;
}

export interface WindowCandidate {
  id: string;
  title: string;
  processName: string;
  pid: number;
}

export interface AttachResult {
  ok: boolean;
  error?: string;
}

export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface McpConnectResult {
  ok: boolean;
  error?: string;
  tools?: McpToolSummary[];
  runtimeIdentity?: RuntimeIdentity;
  workspaceMatch?: RuntimeWorkspaceMatch;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  license: string | null;
  htmlUrl: string;
  defaultBranch: string;
}

export interface RepoSearchResult {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
}

export interface OrganizationRepoListing {
  organization: string;
  repositories: RepoSearchResult[];
  truncated: boolean;
}

export interface CloneResult {
  ok: boolean;
  destPath?: string;
  error?: string;
}

export interface ArtifactStatus {
  flavor: "legacy" | "enhanced";
  track: "recommended" | "latest";
  build: number;
  displayName: string;
  downloadUrl: string;
  archiveSize: number | null;
  publishedAt: string | null;
  installedBuild: number | null;
  updateAvailable: boolean | null;
  recoveryNotice?: string;
}

export interface ArtifactUpdateResult extends ArtifactStatus {
  sha256: string;
  backupPath: string;
  installedAt: string;
  warning?: string;
}

export interface ArtifactProgress {
  target: CfxTarget;
  phase: "checking" | "downloading" | "extracting" | "validating" | "installing" | "complete";
  transferredBytes: number;
  totalBytes: number | null;
}

export interface CrashReportSummary {
  relativePath: string;
  modifiedAt: string;
  excerpt: string;
  truncated: boolean;
}

export interface CrashTriageContext {
  report: CrashReportSummary | null;
  consoleTail: string;
  detectedAt: string;
}

export interface RevertBatchSummary {
  id: string;
  label: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
}

export interface RevertConflict {
  path: string;
  reason: string;
}

export interface RevertResult {
  batchId: string;
  status: "reverted" | "partial" | "conflict" | "not-found";
  reverted: string[];
  skipped: RevertConflict[];
}

export type DetectedClientInstalls = Record<CfxTarget, string | null>;
export type DetectedServerInstalls = Record<CfxTarget, string | null>;
export interface DetectedExecutableInstalls {
  clients: DetectedClientInstalls;
  servers: DetectedServerInstalls;
}

export interface SetupDiagnostics {
  txDataRoot: boolean;
  workspace: boolean;
  serverExecutable: boolean;
  clientExecutable: boolean;
  txAdminAttachment: boolean;
  rconCapability: boolean;
  git: boolean;
}

export interface DevelopmentRconPreviewChange {
  path: "server.cfg" | "secrets.cfg" | ".gitignore";
  action: "create" | "update" | "unchanged";
  description: "load-secret-file" | "write-redacted-password" | "ignore-secret-file";
}

export interface DevelopmentRconPreview {
  hasExistingPassword: boolean;
  changes: DevelopmentRconPreviewChange[];
}

export interface DevelopmentRconResult {
  changedPaths: string[];
  replacedExistingPassword: boolean;
}

export interface WorkspaceSearchRequest {
  scope: "resource" | "workspace";
  resourceRoot: string | null;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string[];
  exclude: string[];
}

export interface WorkspaceSearchMatch {
  id: string;
  filePath: string;
  relativePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
  before: string[];
  after: string[];
}

export interface WorkspaceSearchFileResult {
  filePath: string;
  relativePath: string;
  revision: string;
  matches: WorkspaceSearchMatch[];
}

export interface WorkspaceSearchResult {
  id: string;
  files: WorkspaceSearchFileResult[];
  totalMatches: number;
  truncated: boolean;
  scannedFiles: number;
  skippedCredentialFiles: number;
}

export interface WorkspaceReplaceFilePreview {
  filePath: string;
  relativePath: string;
  originalContent: string;
  modifiedContent: string;
  hitCount: number;
}

export interface WorkspaceReplacePreview {
  searchId: string;
  applyToken: string;
  files: WorkspaceReplaceFilePreview[];
  totalHits: number;
}

export interface WorkspaceReplaceApplyResult {
  searchId: string;
  batchId: string | null;
  filesChanged: number;
  hitsApplied: number;
  changedPaths: string[];
  skipped: Array<{ path: string; reason: string }>;
}

// Mirrors electron/preload.ts's exposeInMainWorld("api", ...) shape.
// Kept as a hand-written duplicate (not a cross-import from electron/)
// since the renderer and electron main process are separate TS projects
// with different module targets.
declare global {
  interface Window {
    api: {
      config: {
        get(): Promise<StudioConfig>;
        set(config: StudioConfig): Promise<StudioConfig>;
        onChanged(callback: (config: StudioConfig) => void): () => void;
      };
      console: {
        openPopout(): Promise<void>;
        openSourceLocation(location: ConsoleSourceLocationRequest): Promise<ResolvedConsoleSourceLocation>;
        requestAgentFix(location: ConsoleSourceLocationRequest, diagnosticLine: string): Promise<void>;
        clearView(): Promise<number>;
        clearGeneration(): Promise<number>;
        setRefreshInterval(intervalMs: number): Promise<number>;
        onRefreshIntervalChanged(callback: (intervalMs: number) => void): () => void;
        onClearViewChanged(callback: (generation: number) => void): () => void;
        onRevealSourceLocation(callback: (location: ResolvedConsoleSourceLocation) => void): () => void;
        onAgentFixPrompt(callback: (prompt: string, workspaceScope: string) => void): () => void;
      };
      theme: {
        system(): Promise<"dark" | "light">;
        listPacks(): Promise<ThemePack[]>;
        importPack(): Promise<ThemePack | null>;
        openPackFolder(): Promise<void>;
        preview(preference: ThemePreference): Promise<void>;
        clearPreview(): Promise<void>;
        onSystemChanged(callback: (theme: "dark" | "light") => void): () => void;
      };
      recents: {
        list(): Promise<RecentWorkspaceSummary[]>;
        select(id: string, allowDiscard: boolean): Promise<StudioConfig>;
      };
      installs: {
        detectClients(): Promise<DetectedClientInstalls>;
        detectAll(txDataPath?: string | null): Promise<DetectedExecutableInstalls>;
      };
      setup: {
        diagnostics(
          txDataPath: string | null,
          profile: string | null,
          target: CfxTarget,
          clientPath: string | null,
          serverPath: string | null,
        ): Promise<SetupDiagnostics>;
      };
      revert: {
        list(): Promise<RevertBatchSummary[]>;
        apply(batchId: string, mode: "all" | "safe"): Promise<RevertResult>;
      };
      search: {
        run(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResult>;
        previewReplace(searchId: string, selectedIds: string[], replacement: string): Promise<WorkspaceReplacePreview>;
        applyReplace(applyToken: string): Promise<WorkspaceReplaceApplyResult>;
      };
      fs: {
        listDir(dirPath: string): Promise<DirEntry[]>;
        readFile(filePath: string): Promise<FileSnapshot>;
        writeFile(filePath: string, content: string, expectedRevision: string): Promise<string>;
        rename(oldPath: string, newName: string): Promise<string>;
        delete(targetPath: string): Promise<void>;
        watchRoot(dirPath: string | null): Promise<void>;
        onChanged(callback: () => void): () => void;
      };
      txdata: {
        listProfiles(txDataPath: string): Promise<ProfileInfo[]>;
        resolveProfile(txDataPath: string, profile: string): Promise<ResolvedProfile>;
        createLocalWorkspace(txDataPath: string, name: string, port: number, target: CfxTarget): Promise<LocalWorkspace>;
        previewDevelopmentRcon(txDataPath: string, profile: string): Promise<DevelopmentRconPreview>;
        applyDevelopmentRcon(txDataPath: string, profile: string, allowOverwrite: boolean): Promise<DevelopmentRconResult>;
      };
      windowEmbed: {
        listCandidates(): Promise<WindowCandidate[]>;
        attach(candidateId: string): Promise<AttachResult>;
        detach(): Promise<void>;
        setRect(x: number, y: number, width: number, height: number, visible: boolean): Promise<void>;
      };
      dialog: {
        chooseFolder(): Promise<string | null>;
        chooseExe(target: CfxTarget): Promise<string | null>;
        chooseFxServerExe(target: CfxTarget): Promise<string | null>;
      };
      mcp: {
        connect(): Promise<McpConnectResult>;
        disconnect(): Promise<void>;
        status(): Promise<{
          connected: boolean;
          url: string | null;
          runtimeIdentity: RuntimeIdentity | null;
          workspaceMatch: RuntimeWorkspaceMatch;
        }>;
        callTool(name: string, args: Record<string, unknown>): Promise<string>;
        onDropped(callback: () => void): () => void;
      };
      resources: {
        listStatuses(): Promise<ResourceStatusResult>;
        context(filePath: string): Promise<ResourceContext | null>;
        dependencyGraph(): Promise<ResourceDependencyGraph>;
        compare(leftRoot: string, rightRoot: string): Promise<ResourceComparison>;
        duplicate(sourceRoot: string, newName: string): Promise<ResourceDuplicateResult>;
        createFile(parentPath: string, name: string): Promise<CreatedResourceEntry>;
        createDirectory(parentPath: string, name: string): Promise<CreatedResourceEntry>;
        createStarter(parentPath: string, name: string, template: "lua" | "static-nui" | "react-nui" | "vue-nui"): Promise<StarterResourceResult>;
        importDroppedFolder(file: File): Promise<ResourceImportResult>;
      };
      bookmarks: {
        list(): Promise<EditorBookmark[]>;
        toggle(filePath: string, line: number): Promise<EditorBookmark[]>;
      };
      github: {
        fetchRepoInfo(input: string): Promise<RepoInfo>;
        searchRepos(input: string): Promise<RepoSearchResult[]>;
        listOrgRepos(input: string): Promise<OrganizationRepoListing | null>;
        cloneRepo(repoUrl: string, projectRoot: string): Promise<CloneResult>;
      };
      cfx: {
        launch(target: CfxTarget): Promise<{ ok: boolean; target: CfxTarget }>;
      };
      server: {
        status(): Promise<{ running: boolean; pids: number[]; target: CfxTarget }>;
        launch(): Promise<{ pid: number; controlProfile: string | null; alreadyRunning: boolean; target: CfxTarget; recoveryNotice?: string }>;
        stop(target: CfxTarget): Promise<{ stoppedPids: number[]; alreadyStopped: boolean; target: CfxTarget }>;
        crashReport(): Promise<CrashReportSummary | null>;
        notifyUnexpectedExit(target: CfxTarget): Promise<{ shown: boolean }>;
      };
      artifacts: {
        check(target: CfxTarget, track: "recommended" | "latest"): Promise<ArtifactStatus>;
        update(target: CfxTarget, track: "recommended" | "latest"): Promise<ArtifactUpdateResult>;
        recoveryNotice(): Promise<string | null>;
        onProgress(callback: (progress: ArtifactProgress) => void): () => void;
      };
      app: {
        setDirtyCount(count: number): Promise<void>;
        setDiscordActivity(context: {
          view: "startup" | "viewport" | "console" | "resources" | "editor" | "review" | "assistant" | "setup" | "settings";
          filePath: string | null;
        }): Promise<void>;
        getUpdateState(): Promise<AppUpdateState>;
        checkForUpdate(manual?: boolean): Promise<AppUpdateState>;
        downloadUpdate(): Promise<AppUpdateState>;
        restartToUpdate(): Promise<AppUpdateState>;
        onUpdateState(callback: (state: AppUpdateState) => void): () => void;
        consumeWhatsNew(): Promise<WhatsNewState | null>;
      };
      lua: {
        start(): Promise<
          | {
              ok: true;
              mode: "balanced" | "full";
              workspaceRoot: string;
              libraryRoot: string;
              version: string;
            }
          | { ok: false; mode: "off" | "balanced" | "full"; error: string }
        >;
        stop(): Promise<void>;
        send(message: unknown): void;
        onMessage(callback: (message: unknown) => void): () => void;
        onStatus(callback: (status: { state: "stopped" | "error"; message?: string }) => void): () => void;
      };
      agent: {
        setApiKey(key: string): Promise<void>;
        hasApiKey(): Promise<boolean>;
        setProviderKey(baseUrl: string, key: string): Promise<void>;
        hasProviderKey(baseUrl: string): Promise<boolean>;
        listModels(
          baseUrl: string,
          keyOverride?: string,
        ): Promise<{ ok: boolean; models?: string[]; toolCapable?: Record<string, boolean>; error?: string }>;
        send(message: string): Promise<void>;
        cancel(): Promise<void>;
        respondToApproval(approvalId: string, approved: boolean): Promise<{ ok: true }>;
        reset(): Promise<void>;
        setEditorContext(context: EditorContext): Promise<void>;
        onFileWritten(callback: (absolutePath: string) => void): () => void;
        onEvent(callback: (event: AgentEvent) => void): () => void;
      };
      shell: {
        openExternal(url: string): Promise<void>;
        showItemInFolder(targetPath: string): Promise<void>;
      };
      clipboard: {
        writeText(value: string): Promise<void>;
      };
    };
  }
}
