import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { FileChangeReview, OpenFile } from "../App";
import { languageForPath } from "../editorLanguage";
import type { CfxTarget, CrashTriageContext, EditorBookmark, EditorPreferences, EditorProblem, ResolvedTheme, ResourceComparison, ResourceContext, ResourceDependencyGraph, WindowCandidate } from "../global";
import { t } from "../i18n";
import type { LuaServiceStatus } from "../luaLanguageService";
import { countNewConsoleLines, filterConsoleOutput, newestErrorBlock, type ConsoleSeverity } from "../consoleText";
import { appendConsoleSnapshot } from "../../electron/consoleViewModel";
import { parseConsoleSourceLocations, type ConsoleSourceLocationRequest } from "../../electron/consoleSourceParser";
import ContextMenu from "./ContextMenu";

export type CenterTab = "viewport" | "console" | "resources" | "editor";

const CodeEditor = lazy(() => import("./CodeEditor"));
const ChangeDiff = lazy(() => import("./ChangeDiff"));
const ChangeReview = lazy(() => import("./ChangeReview"));
const ManifestFormEditor = lazy(() => import("./ManifestFormEditor"));
import { parseManifestForm } from "../../electron/manifestModel";

/**
 * Tab labels, disambiguated by parent folder when bare filenames collide — near-universal
 * in a Cfx.re resource tree, where every resource has its own fxmanifest.lua, client/main.lua, etc.
 * Without this, several tabs read identically with no way to tell which is which.
 */
function tabLabels(openFiles: OpenFile[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const f of openFiles) {
    const name = f.path.split(/[/\\]/).pop() ?? f.path;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const f of openFiles) {
    const parts = f.path.split(/[/\\]/);
    const name = parts.pop() ?? f.path;
    const parent = parts.pop();
    labels.set(f.path, (counts.get(name) ?? 0) > 1 && parent ? `${parent}/${name}` : name);
  }
  return labels;
}

interface CenterPaneProps {
  connected: boolean;
  runtimeReadable: boolean;
  runtimeWritable: boolean;
  consoleAvailable: boolean | null;
  consoleRefreshIntervalMs: number;
  onConsoleRefreshIntervalChange: (intervalMs: number) => Promise<void>;
  resourceLifecycleAvailable: boolean | null;
  clientLabel: string;
  activeCfxTarget: CfxTarget;
  editorPreferences: EditorPreferences;
  resolvedTheme: ResolvedTheme;
  editorProblems: Record<string, EditorProblem[]>;
  editorReveal: { path: string; line: number; column: number; nonce: number } | null;
  changeReviews: Record<string, FileChangeReview>;
  reviewPath: string | null;
  centerTab: CenterTab;
  onSelectCenterTab: (tab: CenterTab) => void;
  openFiles: OpenFile[];
  activePath: string | null;
  activeResourceContext: ResourceContext | null;
  activeResourceState: "started" | "stopped" | undefined;
  resourceAction: string | null;
  onResourceAction: (kind: "start" | "stop" | "restart", name: string) => Promise<boolean>;
  consoleRefreshSignal: { resource: string; nonce: number } | null;
  crashTriage: CrashTriageContext | null;
  onDismissCrashTriage: () => void;
  onSendCrashTriage: (text: string) => void;
  onConsoleOutputChange: (output: string) => void;
  onAgentPrompt: (text: string) => void;
  dependencyGraph: ResourceDependencyGraph;
  bookmarks: EditorBookmark[];
  onToggleBookmark: (path: string, line: number) => void;
  onSelectFileTab: (path: string) => void;
  onCloseFileTab: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string, expectedRevision: string) => Promise<void>;
  onSelectionChange: (path: string, selectedText: string, startLine: number, endLine: number) => void;
  onProblemsChange: (path: string, problems: EditorProblem[]) => void;
  onRevealProblem: (problem: EditorProblem) => void;
  onOpenEditorLocation: (path: string, line: number, column: number) => void;
  onOpenReview: (path: string) => void;
  onCloseReview: () => void;
  onDismissReview: (review: FileChangeReview) => void;
  onUseDiskVersion: (review: FileChangeReview) => void;
  onSaveEditorVersion: (review: FileChangeReview) => void;
}

export default function CenterPane({
  connected,
  runtimeReadable,
  runtimeWritable,
  consoleAvailable,
  consoleRefreshIntervalMs,
  onConsoleRefreshIntervalChange,
  resourceLifecycleAvailable,
  clientLabel,
  activeCfxTarget,
  editorPreferences,
  resolvedTheme,
  editorProblems,
  editorReveal,
  changeReviews,
  reviewPath,
  centerTab,
  onSelectCenterTab,
  openFiles,
  activePath,
  activeResourceContext,
  activeResourceState,
  resourceAction,
  onResourceAction,
  consoleRefreshSignal,
  crashTriage,
  onDismissCrashTriage,
  onSendCrashTriage,
  onConsoleOutputChange,
  onAgentPrompt,
  dependencyGraph,
  bookmarks,
  onToggleBookmark,
  onSelectFileTab,
  onCloseFileTab,
  onChange,
  onSave,
  onSelectionChange,
  onProblemsChange,
  onRevealProblem,
  onOpenEditorLocation,
  onOpenReview,
  onCloseReview,
  onDismissReview,
  onUseDiskVersion,
  onSaveEditorVersion,
}: CenterPaneProps) {
  const activeFile = openFiles.find((f) => f.path === activePath);
  const activeReview = activeFile && reviewPath === activeFile.path ? changeReviews[activeFile.path] : undefined;
  const labels = tabLabels(openFiles);
  const openPathKey = openFiles.map((file) => file.path).join("\0");
  // Content edits replace OpenFile objects, but the Monaco lifecycle depends
  // only on the tab paths. Keep this array stable while the tab set is stable.
  const openPaths = useMemo(() => openFiles.map((file) => file.path), [openPathKey]);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [rawManifestPaths, setRawManifestPaths] = useState<Set<string>>(() => new Set());
  const [splitPath, setSplitPath] = useState<string | null>(null);
  const [luaService, setLuaService] = useState<{ status: LuaServiceStatus; message?: string }>({ status: "stopped" });
  const handleLuaStatusChange = useCallback((status: LuaServiceStatus, message?: string) => {
    setLuaService((current) => current.status === status && current.message === message ? current : { status, message });
  }, []);
  const problems = Object.values(editorProblems)
    .flat()
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  const errorCount = problems.filter((problem) => problem.severity === "error").length;
  const warningCount = problems.filter((problem) => problem.severity === "warning").length;
  const isManifest = activeFile?.path.split(/[/\\]/).pop()?.toLowerCase() === "fxmanifest.lua";
  const manifestParse = isManifest && activeFile ? parseManifestForm(activeFile.content) : null;
  const manifestRaw = Boolean(activeFile && (rawManifestPaths.has(activeFile.path) || manifestParse?.ok === false));
  const breadcrumbs = activeFile && activeResourceContext
    ? [
        activeResourceContext.name,
        ...activeFile.path.slice(activeResourceContext.rootPath.length).replace(/^[\\/]+/, "").split(/[\\/]/).filter(Boolean),
      ]
    : [];
  const splitFile = openFiles.find((file) => file.path === splitPath && file.path !== activePath);

  useEffect(() => {
    if (splitPath && (!openFiles.some((file) => file.path === splitPath) || splitPath === activePath)) {
      setSplitPath(null);
    }
  }, [activePath, openFiles, splitPath]);

  useEffect(() => {
    if (!editorReveal || editorReveal.path.split(/[/\\]/).pop()?.toLowerCase() !== "fxmanifest.lua") return;
    setRawManifestPaths((current) => current.has(editorReveal.path)
      ? current
      : new Set(current).add(editorReveal.path));
  }, [editorReveal]);

  const renderCodeEditor = (file: OpenFile, revealLocation: CenterPaneProps["editorReveal"] = null) => (
    <CodeEditor
      file={file}
      openPaths={openPaths}
      language={languageForPath(file.path)}
      preferences={editorPreferences}
      resolvedTheme={resolvedTheme}
      luaActive={openFiles.some((openFile) => languageForPath(openFile.path) === "lua")}
      luaTarget={activeCfxTarget}
      reveal={revealLocation}
      onChange={onChange}
      onSave={onSave}
      onSelectionChange={(selectedText, startLine, endLine) => onSelectionChange(file.path, selectedText, startLine, endLine)}
      onProblemsChange={onProblemsChange}
      onOpenLocation={onOpenEditorLocation}
      onLuaStatusChange={handleLuaStatusChange}
      onAgentPrompt={onAgentPrompt}
      resourceNames={dependencyGraph.nodes.map((node) => node.name)}
      bookmarkLines={bookmarks.filter((bookmark) => bookmark.path === file.path).map((bookmark) => bookmark.line)}
      onToggleBookmark={onToggleBookmark}
    />
  );

  return (
    <div className="pane" style={{ height: "100%" }}>
      <div className="editor-tabbar" role="tablist" aria-label="QB Studio views">
        <button
          className={`editor-tab pinned ${centerTab === "viewport" ? "active" : ""}`}
          role="tab"
          aria-selected={centerTab === "viewport"}
          onClick={() => onSelectCenterTab("viewport")}
        >
          <span className="icon">🎮</span>
          <span>Viewport</span>
        </button>
        <button
          className={`editor-tab pinned ${centerTab === "console" ? "active" : ""}`}
          role="tab"
          aria-selected={centerTab === "console"}
          onClick={() => onSelectCenterTab("console")}
        >
          <span className="icon">📟</span>
          <span>Console</span>
        </button>
        <button
          className={`editor-tab pinned ${centerTab === "resources" ? "active" : ""}`}
          role="tab"
          aria-selected={centerTab === "resources"}
          onClick={() => onSelectCenterTab("resources")}
        >
          <svg className="tab-icon" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2" width="5" height="5" rx="1" />
            <rect x="9.5" y="2" width="5" height="5" rx="1" />
            <rect x="5.5" y="9" width="5" height="5" rx="1" />
          </svg>
          <span>Resources</span>
        </button>
        {openFiles.map((f) => (
          <div
            key={f.path}
            className={`editor-tab file-tab ${centerTab === "editor" && f.path === activePath ? "active" : ""}`}
            title={f.path}
          >
            <button
              type="button"
              className="file-tab-select"
              role="tab"
              aria-selected={centerTab === "editor" && f.path === activePath}
              onClick={() => {
                onSelectFileTab(f.path);
                onSelectCenterTab("editor");
              }}
            >
              {f.dirty && <span className="dirty-dot" />}
              <span>{labels.get(f.path)}</span>
              {(editorProblems[f.path]?.length ?? 0) > 0 && (
                <span className="problem-badge" aria-label={`${editorProblems[f.path].length} problems`}>
                  {editorProblems[f.path].length}
                </span>
              )}
              {changeReviews[f.path] && (
                <span className={`change-badge ${changeReviews[f.path].kind}`} aria-label="Changes available to review">
                  Δ
                </span>
              )}
            </button>
            <button
              type="button"
              className="close"
              aria-label={`Close ${labels.get(f.path)}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseFileTab(f.path);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* Sections stay mounted, toggled with CSS — this is what lets the
            embedded Cfx.re client window (and the console's fetched output) survive switching
            to/from a file tab instead of being torn down and rebuilt every time. */}
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "viewport" ? "flex" : "none" }}>
          <ViewportSection active={centerTab === "viewport"} clientLabel={clientLabel} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "console" ? "flex" : "none" }}>
          <ConsoleSection
            active={centerTab === "console"}
            connected={connected}
            available={consoleAvailable}
            refreshIntervalMs={consoleRefreshIntervalMs}
            onRefreshIntervalChange={onConsoleRefreshIntervalChange}
            refreshSignal={consoleRefreshSignal}
            crashTriage={crashTriage}
            onDismissCrashTriage={onDismissCrashTriage}
            onSendCrashTriage={onSendCrashTriage}
            onOutputChange={onConsoleOutputChange}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: centerTab === "resources" ? "flex" : "none" }}>
          <ResourcesSection
            connected={connected}
            runtimeReadable={runtimeReadable}
            runtimeWritable={runtimeWritable}
            resourceLifecycleAvailable={resourceLifecycleAvailable}
            dependencyGraph={dependencyGraph}
            editorPreferences={editorPreferences}
            resolvedTheme={resolvedTheme}
            onOpenManifest={(path) => onOpenEditorLocation(path, 1, 1)}
          />
        </div>
        <div className="editor-workbench" style={{ flex: 1, minHeight: 0, display: centerTab === "editor" ? "flex" : "none" }}>
          {activeFile ? (
            <>
              <div className="editor-surface" style={{ display: activeReview ? "none" : "flex" }}>
                {activeResourceContext && (
                  <div className={`editor-resource-bar ${activeResourceState ?? "unknown"}`} role="status">
                    <span className={`resource-state-dot ${activeResourceState ?? "unknown"}`} aria-hidden="true" />
                    <nav className="editor-breadcrumbs" aria-label={t("editor.breadcrumbs")}>
                      {breadcrumbs.map((part, index) => (
                        <span key={`${part}:${index}`}>
                          {index > 0 && <span className="editor-breadcrumb-separator" aria-hidden="true">/</span>}
                          <strong>{part}</strong>
                        </span>
                      ))}
                    </nav>
                    <span className="editor-resource-message">
                      {activeResourceState === "stopped"
                        ? t("editor.resourceStopped", { resource: activeResourceContext.name })
                        : t(`resource.state.${activeResourceState ?? "unknown"}`)}
                    </span>
                    {isManifest && activeFile && (
                      <>
                        <button
                          type="button"
                          className={`btn small ${!manifestRaw ? "primary" : ""}`}
                          disabled={manifestParse?.ok === false}
                          title={manifestParse?.ok === false ? t("manifest.rawRequired", { reason: manifestParse.reason }) : undefined}
                          onClick={() => setRawManifestPaths((current) => {
                            const next = new Set(current);
                            next.delete(activeFile.path);
                            return next;
                          })}
                        >
                          {t("manifest.viewForm")}
                        </button>
                        <button
                          type="button"
                          className={`btn small ${manifestRaw ? "primary" : ""}`}
                          onClick={() => setRawManifestPaths((current) => new Set(current).add(activeFile.path))}
                        >
                          {t("manifest.viewRaw")}
                        </button>
                      </>
                    )}
                    {activeResourceState === "started" && (
                      <button
                        type="button"
                        className="btn small"
                        disabled={!runtimeWritable || resourceAction !== null}
                        onClick={() => void onResourceAction("restart", activeResourceContext.name)}
                      >
                        {resourceAction === `restart:${activeResourceContext.name}` ? t("common.restarting") : t("editor.restartResource")}
                      </button>
                    )}
                    {activeResourceState === "stopped" && (
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={!runtimeWritable || resourceAction !== null}
                        onClick={() => void onResourceAction("start", activeResourceContext.name)}
                      >
                        {resourceAction === `start:${activeResourceContext.name}` ? t("common.starting") : t("editor.startResource")}
                      </button>
                    )}
                  </div>
                )}
                <div className="editor-monaco-surface">
                  <Suspense fallback={<div className="editor-empty">Loading editor…</div>}>
                    {splitFile ? (
                      <Group orientation="horizontal">
                        <Panel defaultSize="50" minSize="20">
                          <div className="editor-split-panel">
                            <div className="editor-split-header" title={activeFile.path}>{labels.get(activeFile.path)}</div>
                            <div className="editor-split-body">
                              {isManifest && !manifestRaw
                                ? <ManifestFormEditor file={activeFile} onChange={onChange} onSave={onSave} />
                                : renderCodeEditor(activeFile, editorReveal)}
                            </div>
                          </div>
                        </Panel>
                        <Separator className="resize-handle resize-handle-h" />
                        <Panel defaultSize="50" minSize="20">
                          <div className="editor-split-panel">
                            <div className="editor-split-header" title={splitFile.path}>
                              <span>{labels.get(splitFile.path)}</span>
                              <button type="button" onClick={() => setSplitPath(null)} aria-label={t("editor.split.close")}>×</button>
                            </div>
                            <div className="editor-split-body">{renderCodeEditor(splitFile)}</div>
                          </div>
                        </Panel>
                      </Group>
                    ) : isManifest && !manifestRaw ? (
                      <ManifestFormEditor file={activeFile} onChange={onChange} onSave={onSave} />
                    ) : renderCodeEditor(activeFile, editorReveal)}
                  </Suspense>
                </div>
              </div>
              {activeReview && (
                <div className="change-review-surface">
                  <Suspense fallback={<div className="editor-empty">Loading change review…</div>}>
                    <ChangeReview
                      review={activeReview.kind === "conflict" ? { ...activeReview, originalContent: activeFile.content } : activeReview}
                      language={languageForPath(activeReview.path)}
                      preferences={editorPreferences}
                      resolvedTheme={resolvedTheme}
                      onBack={onCloseReview}
                      onDismiss={() => onDismissReview(activeReview)}
                      onUseDisk={() => onUseDiskVersion(activeReview)}
                      onSaveEditor={() => onSaveEditorVersion(activeReview)}
                    />
                  </Suspense>
                </div>
              )}
              {problemsOpen && !activeReview && (
                <section className="problems-panel" aria-label="Problems">
                  {problems.length === 0 ? (
                    <div className="problems-empty">No problems detected in open files.</div>
                  ) : problems.map((problem, index) => (
                    <button
                      key={`${problem.path}:${problem.line}:${problem.column}:${problem.message}:${index}`}
                      className={`problem-row ${problem.severity}`}
                      type="button"
                      onClick={() => onRevealProblem(problem)}
                    >
                      <span className="problem-severity" aria-hidden="true">
                        {problem.severity === "error" ? "×" : problem.severity === "warning" ? "!" : "i"}
                      </span>
                      <span className="problem-message">{problem.message}</span>
                      <span className="problem-location">
                        {problem.path.split(/[/\\]/).pop()}:{problem.line}:{problem.column}
                      </span>
                    </button>
                  ))}
                </section>
              )}
              <div className="editor-statusbar">
                <span>{languageForPath(activeFile.path)}</span>
                <label className="editor-split-control">
                  <span>{t("editor.split.label")}</span>
                  <select value={splitFile?.path ?? ""} onChange={(event) => setSplitPath(event.target.value || null)}>
                    <option value="">{t("editor.split.none")}</option>
                    {openFiles.filter((file) => file.path !== activeFile.path).map((file) => (
                      <option key={file.path} value={file.path}>{labels.get(file.path)}</option>
                    ))}
                  </select>
                </label>
                {languageForPath(activeFile.path) === "lua" && (
                  <span
                    className={`lua-service-status ${luaService.status}`}
                    title={luaService.message}
                  >
                    Lua: {luaService.status}
                  </span>
                )}
                {changeReviews[activeFile.path] && !activeReview && (
                  <button type="button" className="has-review" onClick={() => onOpenReview(activeFile.path)}>
                    Review changes
                  </button>
                )}
                <button
                  type="button"
                  className={problems.length > 0 ? "has-problems" : ""}
                  onClick={() => setProblemsOpen((open) => !open)}
                  aria-expanded={problemsOpen}
                >
                  Problems: {errorCount} errors, {warningCount} warnings
                </button>
              </div>
            </>
          ) : (
            <div className="editor-empty">
              <div>No file open</div>
              <div style={{ fontSize: 11 }}>Pick a file from the resource tree on the left.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CONSOLE_REFRESH_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1_000, label: "Every second" },
  { value: 2_000, label: "Every 2 seconds" },
  { value: 5_000, label: "Every 5 seconds" },
  { value: 10_000, label: "Every 10 seconds" },
  { value: 30_000, label: "Every 30 seconds" },
] as const;

function LinkedConsoleOutput({
  output,
  onOpen,
  onAgentFix,
}: {
  output: string;
  onOpen: (location: ConsoleSourceLocationRequest) => void;
  onAgentFix: (location: ConsoleSourceLocationRequest, diagnosticLine: string) => void;
}) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    location: ConsoleSourceLocationRequest;
    diagnosticLine: string;
    accessiblePath: string;
  } | null>(null);
  const lines = output.split("\n");
  const linkedLines = lines.map((line, lineIndex) => {
    const locations = parseConsoleSourceLocations(line);
    const content: ReactNode[] = [];
    let offset = 0;
    for (const location of locations) {
      if (location.start > offset) content.push(line.slice(offset, location.start));
      const request: ConsoleSourceLocationRequest = {
        kind: location.kind,
        source: location.source,
        ...(location.resourceName ? { resourceName: location.resourceName } : {}),
        line: location.line,
        column: location.column,
      };
      const accessiblePath = location.resourceName
        ? `@${location.resourceName}/${location.source}`
        : location.source;
      content.push(
        <button
          className="console-source-link"
          type="button"
          key={`${location.start}:${location.end}`}
          title={t("console.openSource", { path: accessiblePath, line: location.line, column: location.column })}
          aria-label={t("console.openSource", { path: accessiblePath, line: location.line, column: location.column })}
          aria-haspopup="menu"
          onClick={() => {
            setMenu(null);
            onOpen(request);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            const openedFromKeyboard = event.clientX === 0 && event.clientY === 0;
            setMenu({
              x: openedFromKeyboard ? bounds.left + 4 : event.clientX,
              y: openedFromKeyboard ? bounds.bottom + 2 : event.clientY,
              location: request,
              diagnosticLine: line,
              accessiblePath,
            });
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({
              x: bounds.left + 4,
              y: bounds.bottom + 2,
              location: request,
              diagnosticLine: line,
              accessiblePath,
            });
          }}
        >
          {line.slice(location.start, location.end)}
        </button>,
      );
      offset = location.end;
    }
    if (offset < line.length) content.push(line.slice(offset));
    return (
      <Fragment key={lineIndex}>
        {content}
        {lineIndex < lines.length - 1 ? "\n" : null}
      </Fragment>
    );
  });

  return (
    <>
      {linkedLines}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={t("console.sourceMenu", { path: menu.accessiblePath })}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t("console.sourceMenu.open"),
              onClick: () => onOpen(menu.location),
            },
            {
              label: t("console.sourceMenu.agentFix"),
              onClick: () => onAgentFix(menu.location, menu.diagnosticLine),
            },
          ]}
        />
      )}
    </>
  );
}

function ConsoleSection({
  active,
  connected,
  available,
  refreshIntervalMs,
  onRefreshIntervalChange,
  refreshSignal,
  crashTriage,
  onDismissCrashTriage,
  onSendCrashTriage,
  onOutputChange,
}: {
  active: boolean;
  connected: boolean;
  available: boolean | null;
  refreshIntervalMs: number;
  onRefreshIntervalChange: (intervalMs: number) => Promise<void>;
  refreshSignal: { resource: string; nonce: number } | null;
  crashTriage: CrashTriageContext | null;
  onDismissCrashTriage: () => void;
  onSendCrashTriage: (text: string) => void;
  onOutputChange: (output: string) => void;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <ConsolePanel
        active={active}
        connected={connected}
        available={available}
        refreshIntervalMs={refreshIntervalMs}
        onRefreshIntervalChange={onRefreshIntervalChange}
        refreshSignal={refreshSignal}
        crashTriage={crashTriage}
        onDismissCrashTriage={onDismissCrashTriage}
        onSendCrashTriage={onSendCrashTriage}
        onOutputChange={onOutputChange}
        onOpenPopout={() => void window.api.console.openPopout()}
      />
    </div>
  );
}

export function ConsolePanel({
  active,
  connected,
  available,
  refreshIntervalMs,
  onRefreshIntervalChange,
  refreshSignal,
  crashTriage,
  onDismissCrashTriage,
  onSendCrashTriage,
  onOutputChange,
  onOpenPopout,
}: {
  active: boolean;
  connected: boolean;
  available: boolean | null;
  refreshIntervalMs: number;
  onRefreshIntervalChange: (intervalMs: number) => Promise<void>;
  refreshSignal: { resource: string; nonce: number } | null;
  crashTriage: CrashTriageContext | null;
  onDismissCrashTriage: () => void;
  onSendCrashTriage: (text: string) => void;
  onOutputChange: (output: string) => void;
  onOpenPopout?: () => void;
}) {
  const [output, setOutput] = useState("");
  const [paused, setPaused] = useState(false);
  const [bufferedLines, setBufferedLines] = useState(0);
  const [severity, setSeverity] = useState<ConsoleSeverity>("all");
  const [textFilter, setTextFilter] = useState("");
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [viewCleared, setViewCleared] = useState(false);
  const requestRef = useRef<Promise<void> | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const latestOutputRef = useRef("");
  const latestRawOutputRef = useRef("");
  const clearActiveRef = useRef(false);
  const clearOnNextRefreshRef = useRef(false);
  const pausedRef = useRef(false);
  const frozenOutputRef = useRef("");

  const acceptOutput = useCallback((next: string) => {
    let visible = next;
    if (clearOnNextRefreshRef.current) {
      clearOnNextRefreshRef.current = false;
      clearActiveRef.current = true;
      visible = "";
    } else if (clearActiveRef.current) {
      visible = appendConsoleSnapshot(latestRawOutputRef.current, next, latestOutputRef.current);
    }
    latestRawOutputRef.current = next;
    latestOutputRef.current = visible;
    onOutputChange(next);
    if (pausedRef.current) {
      setBufferedLines(countNewConsoleLines(frozenOutputRef.current, visible));
      return;
    }
    frozenOutputRef.current = visible;
    setOutput(visible);
    setViewCleared(clearActiveRef.current && visible === "");
  }, [onOutputChange]);

  const clearView = useCallback(() => {
    if (latestRawOutputRef.current) {
      clearActiveRef.current = true;
    } else {
      clearOnNextRefreshRef.current = true;
    }
    latestOutputRef.current = "";
    frozenOutputRef.current = "";
    setOutput("");
    setViewCleared(true);
    setBufferedLines(0);
    setSourceError(null);
    stickToBottomRef.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api.console.clearGeneration().then((generation) => {
      if (!cancelled && generation > 0) clearView();
    });
    const unsubscribe = window.api.console.onClearViewChanged(() => clearView());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [clearView]);

  const refresh = useCallback((showLoading: boolean): Promise<void> => {
    if (requestRef.current) return requestRef.current;
    const view = outputRef.current;
    stickToBottomRef.current = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 32;
    if (showLoading) setLoading(true);
    setError(null);
    const request = window.api.mcp
      .callTool("get_console_output", { lines: 200 })
      .then(acceptOutput)
      .catch((err) => setError((err as Error).message))
      .finally(() => {
        requestRef.current = null;
        if (showLoading) setLoading(false);
      });
    requestRef.current = request;
    return request;
  }, [acceptOutput]);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!active || !pageVisible || !connected || available !== true || refreshIntervalMs === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh(false);
      if (!cancelled) timer = setTimeout(poll, refreshIntervalMs);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, available, connected, pageVisible, refresh, refreshIntervalMs]);

  useEffect(() => {
    if (stickToBottomRef.current && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  useEffect(() => {
    if (!refreshSignal || !connected || available !== true) return;
    setRefreshNotice(t("console.refreshAfterRestart", { resource: refreshSignal.resource }));
    const timer = setTimeout(() => {
      void refresh(false).finally(() => setRefreshNotice(null));
    }, 600);
    return () => clearTimeout(timer);
  }, [available, connected, refresh, refreshSignal]);

  async function changeRefreshInterval(intervalMs: number) {
    setSavingInterval(true);
    setError(null);
    try {
      await onRefreshIntervalChange(intervalMs);
    } catch (err) {
      setError(`Could not save the console refresh interval: ${(err as Error).message}`);
    } finally {
      setSavingInterval(false);
    }
  }

  function togglePaused() {
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      setBufferedLines(0);
      frozenOutputRef.current = latestOutputRef.current;
      stickToBottomRef.current = true;
      setOutput(latestOutputRef.current);
      return;
    }
    pausedRef.current = true;
    frozenOutputRef.current = output;
    setPaused(true);
  }

  async function copyLastError() {
    const block = newestErrorBlock(output);
    if (!block) {
      setCopyNotice(t("console.noError"));
      return;
    }
    try {
      await window.api.clipboard.writeText(block);
      setCopyNotice(t("console.copiedError"));
    } catch (copyError) {
      setCopyNotice((copyError as Error).message);
    }
  }

  const openSourceLocation = useCallback(async (location: ConsoleSourceLocationRequest) => {
    setSourceError(null);
    try {
      await window.api.console.openSourceLocation(location);
    } catch (openError) {
      setSourceError(t("console.openSourceError", { message: (openError as Error).message }));
    }
  }, []);

  const requestAgentFix = useCallback(async (location: ConsoleSourceLocationRequest, diagnosticLine: string) => {
    setSourceError(null);
    try {
      await window.api.console.requestAgentFix(location, diagnosticLine);
    } catch (requestError) {
      setSourceError(t("console.agentFixError", { message: (requestError as Error).message }));
    }
  }, []);

  const visibleOutput = useMemo(
    () => filterConsoleOutput(output, severity, textFilter),
    [output, severity, textFilter],
  );

  function sendCrashContext() {
    if (!crashTriage) return;
    const reportSection = crashTriage.report
      ? `Newest crash artifact (${crashTriage.report.relativePath}):\n${crashTriage.report.excerpt}`
      : "No crash artifact was found.";
    const consoleSection = crashTriage.consoleTail || "No recent console output was captured.";
    onSendCrashTriage(
      `Please triage this unexpected FXServer exit. Identify the likely cause, point to the relevant resource or config when possible, and recommend the safest next check.\n\n${reportSection}\n\nLast 50 console lines:\n${consoleSection}`,
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <div className="console-toolbar">
        <button className="btn small" onClick={() => void refresh(true)} disabled={loading || !connected || available !== true}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          className="btn small"
          type="button"
          onClick={() => void window.api.console.clearView()}
          title={t("console.clearViewHelp")}
        >
          {t("console.clearView")}
        </button>
        <button className={`btn small ${paused ? "active" : ""}`} onClick={togglePaused} aria-pressed={paused}>
          {paused ? t("console.resume") : t("console.pause")}
        </button>
        <button className="btn small" onClick={() => void copyLastError()}>
          {t("console.copyLastError")}
        </button>
        {onOpenPopout && (
          <button className="btn small" type="button" onClick={onOpenPopout}>
            {t("console.openPopout")}
          </button>
        )}
        <div className="console-severity-chips" role="group" aria-label={t("console.severity.label")}>
          {(["all", "error", "warning"] as const).map((nextSeverity) => (
            <button
              key={nextSeverity}
              type="button"
              className={`console-chip ${severity === nextSeverity ? "active" : ""} ${nextSeverity}`}
              aria-pressed={severity === nextSeverity}
              onClick={() => setSeverity(nextSeverity)}
            >
              {t(nextSeverity === "all" ? "console.severity.all" : nextSeverity === "error" ? "console.severity.errors" : "console.severity.warnings")}
            </button>
          ))}
        </div>
        <input
          className="console-filter"
          value={textFilter}
          onChange={(event) => setTextFilter(event.target.value)}
          placeholder={t("console.filter.placeholder")}
          aria-label={t("console.filter.placeholder")}
        />
        <label className="console-refresh-control">
          <span>Auto-refresh</span>
          <select
            aria-label="Console auto-refresh interval"
            value={refreshIntervalMs}
            onChange={(event) => void changeRefreshInterval(Number(event.target.value))}
            disabled={savingInterval}
          >
            {CONSOLE_REFRESH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        {refreshNotice && <span className="console-refresh-notice" aria-live="polite">{refreshNotice}</span>}
      </div>
      {paused && bufferedLines > 0 && (
        <button type="button" className="console-buffered-banner" onClick={togglePaused}>
          {t("console.buffered", { count: bufferedLines })}
        </button>
      )}
      {copyNotice && (
        <div className="console-copy-notice" role="status">
          {copyNotice}
          <button className="banner-dismiss" type="button" onClick={() => setCopyNotice(null)} aria-label={t("common.dismiss")}>×</button>
        </div>
      )}
      {crashTriage && (
        <section className="console-crash-card" aria-label={t("console.crashTitle")}>
          <div className="console-crash-head">
            <strong>{t("console.crashTitle")}</strong>
            <span>{new Date(crashTriage.detectedAt).toLocaleString()}</span>
          </div>
          <div>
            {crashTriage.report
              ? t("console.crashReport", { path: crashTriage.report.relativePath })
              : t("console.crashNoReport")}
          </div>
          <div className="console-crash-actions">
            <button className="btn small primary" type="button" onClick={sendCrashContext}>{t("console.crashSend")}</button>
            <button className="btn small" type="button" onClick={onDismissCrashTriage}>{t("console.crashDismiss")}</button>
          </div>
        </section>
      )}
      {connected && available === false && (
        <div className="operations-empty" role="status">
          Console tailing requires exactly one txAdmin control profile whose <code>config.json</code> {" "}
          <code>server.dataPath</code> points to this workspace. Start FXServer, then open Settings and Save again to rescan.
        </div>
      )}
      {error && <div className="error-text" style={{ padding: "0 8px" }}>{error}</div>}
      {sourceError && <div className="error-text console-source-error" role="alert">{sourceError}</div>}
      <div
        ref={outputRef}
        className="console-lines"
        style={{ flex: 1, overflow: "auto" }}
        aria-live={refreshIntervalMs === 0 ? "polite" : "off"}
      >
        {visibleOutput
          ? (
              <LinkedConsoleOutput
                output={visibleOutput}
                onOpen={(location) => void openSourceLocation(location)}
                onAgentFix={(location, diagnosticLine) => void requestAgentFix(location, diagnosticLine)}
              />
            )
          : (output
              ? `(${t("console.noMatches")})`
              : viewCleared
                ? `(${t("console.viewCleared")})`
              : available === false
                ? "(console not attached yet)"
                : refreshIntervalMs === 0
                  ? "(no output yet — click Refresh)"
                  : "(waiting for console output…)" )}
      </div>
    </div>
  );
}

function ResourcesSection({
  connected,
  runtimeReadable,
  runtimeWritable,
  resourceLifecycleAvailable,
  dependencyGraph,
  editorPreferences,
  resolvedTheme,
  onOpenManifest,
}: {
  connected: boolean;
  runtimeReadable: boolean;
  runtimeWritable: boolean;
  resourceLifecycleAvailable: boolean | null;
  dependencyGraph: ResourceDependencyGraph;
  editorPreferences: EditorPreferences;
  resolvedTheme: ResolvedTheme;
  onOpenManifest: (path: string) => void;
}) {
  const [output, setOutput] = useState("");
  const [resourceName, setResourceName] = useState("");
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setOutput(await window.api.mcp.callTool("list_resources", {}));
    } catch (err) {
      setError((err as Error).message || "Could not list local resources.");
    } finally {
      setLoading(false);
    }
  }

  async function runLifecycle(kind: "start" | "stop" | "restart", name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter or select a resource name first.");
      return;
    }
    if (kind === "stop") {
      const dependents = dependencyGraph.nodes.find((node) => node.name.toLowerCase() === trimmed.toLowerCase())?.dependents ?? [];
      const confirmation = dependents.length > 0
        ? t("resource.confirmStopDependents", { resource: trimmed, dependents: dependents.join(", ") })
        : t("resource.confirmStop", { resource: trimmed });
      if (!confirm(confirmation)) return;
    }
    setAction(`${kind}:${trimmed}`);
    setError(null);
    setMessage(null);
    try {
      const tool = kind === "start" ? "start_resource" : kind === "stop" ? "stop_resource" : "restart_resource";
      const result = await window.api.mcp.callTool(tool, { name: trimmed });
      setMessage(result || `Sent ${kind} for ${trimmed}.`);
      await refresh();
    } catch (err) {
      setError((err as Error).message || `Could not ${kind} ${trimmed}.`);
    } finally {
      setAction(null);
    }
  }

  return (
    <section className="operations-view" aria-labelledby="resources-heading">
      <div className="operations-toolbar">
        <div>
          <h2 id="resources-heading">Resources</h2>
          <div className="operations-source">Local coding runtime</div>
        </div>
        <button className="btn small" onClick={() => void refresh()} disabled={loading || !runtimeReadable}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="operations-action-row">
        <label className="sr-only" htmlFor="resource-name">Resource name</label>
        <input id="resource-name" value={resourceName} onChange={(e) => setResourceName(e.target.value)} placeholder="Resource name" />
        <button className="btn small" onClick={() => void runLifecycle("start", resourceName)} disabled={action !== null || !runtimeWritable}>Start</button>
        <button className="btn small primary" onClick={() => void runLifecycle("restart", resourceName)} disabled={action !== null || !runtimeWritable}>Restart</button>
        <button className="btn small danger-button" onClick={() => void runLifecycle("stop", resourceName)} disabled={action !== null || !runtimeWritable}>Stop</button>
      </div>
      {connected && resourceLifecycleAvailable === false && (
        <div className="operations-empty" role="status">
          Add <code>set rcon_password "..."</code> to <code>server.cfg</code> or an <code>exec</code>-loaded sibling
          config, restart FXServer, then open Settings and Save again. The password is not stored in Settings.
        </div>
      )}
      {error && <div className="error-text" role="alert">{error}</div>}
      {message && <pre className="operation-result" aria-live="polite">{message}</pre>}
      {output && <pre className="operation-result">{output}</pre>}
      {!connected && <div className="operations-empty">Choose a workspace to start the bundled local runtime.</div>}
      {!output && !loading && !error && runtimeReadable && <div className="operations-empty">Refresh to compare workspace resources with the local server's started resources.</div>}
      <section className="dependency-graph" aria-labelledby="dependency-graph-heading">
        <div className="dependency-graph-heading">
          <div>
            <h3 id="dependency-graph-heading">{t("dependencies.title")}</h3>
            <span>{t("dependencies.help")}</span>
          </div>
          <span>{t("dependencies.count", { count: dependencyGraph.nodes.length })}</span>
        </div>
        {dependencyGraph.nodes.length === 0 ? (
          <div className="operations-empty">{t("dependencies.empty")}</div>
        ) : (
          <div className="dependency-node-list">
            {dependencyGraph.nodes.map((node) => (
              <article className="dependency-node" key={node.rootPath}>
                <button type="button" className="dependency-node-name" onClick={() => onOpenManifest(node.manifestPath)}>
                  {node.name}
                </button>
                <div><strong>{t("dependencies.requires")}</strong> {node.dependencies.join(", ") || t("dependencies.none")}</div>
                <div><strong>{t("dependencies.usedBy")}</strong> {node.dependents.join(", ") || t("dependencies.none")}</div>
                {node.missingDependencies.length > 0 && (
                  <div className="dependency-warning">{t("dependencies.missing", { dependencies: node.missingDependencies.join(", ") })}</div>
                )}
                {node.manifestWarning && <div className="dependency-warning">{t("dependencies.dynamic", { reason: node.manifestWarning })}</div>}
              </article>
            ))}
          </div>
        )}
      </section>
      <ResourceCompareSection
        dependencyGraph={dependencyGraph}
        editorPreferences={editorPreferences}
        resolvedTheme={resolvedTheme}
      />
    </section>
  );
}

function ResourceCompareSection({
  dependencyGraph,
  editorPreferences,
  resolvedTheme,
}: {
  dependencyGraph: ResourceDependencyGraph;
  editorPreferences: EditorPreferences;
  resolvedTheme: ResolvedTheme;
}) {
  const [leftRoot, setLeftRoot] = useState("");
  const [rightRoot, setRightRoot] = useState("");
  const [comparison, setComparison] = useState<ResourceComparison | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const roots = dependencyGraph.nodes.map((node) => node.rootPath);
    setLeftRoot((current) => roots.includes(current) ? current : (roots[0] ?? ""));
    setRightRoot((current) => roots.includes(current) && current !== (roots[0] ?? "") ? current : (roots[1] ?? ""));
    setComparison(null);
    setSelectedPath(null);
  }, [dependencyGraph]);

  async function compare() {
    if (!leftRoot || !rightRoot || leftRoot === rightRoot) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.api.resources.compare(leftRoot, rightRoot);
      setComparison(result);
      setSelectedPath(result.files[0]?.relativePath ?? null);
    } catch (compareError) {
      setComparison(null);
      setSelectedPath(null);
      setError((compareError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const selected = comparison?.files.find((file) => file.relativePath === selectedPath);
  return (
    <section className="resource-compare" aria-labelledby="resource-compare-heading">
      <div className="dependency-graph-heading">
        <div>
          <h3 id="resource-compare-heading">{t("resource.compare.title")}</h3>
          <span>{t("resource.compare.help")}</span>
        </div>
      </div>
      <div className="resource-compare-controls">
        <select aria-label={t("resource.compare.left")} value={leftRoot} onChange={(event) => setLeftRoot(event.target.value)}>
          {dependencyGraph.nodes.map((node) => <option key={node.rootPath} value={node.rootPath}>{node.name}</option>)}
        </select>
        <span aria-hidden="true">↔</span>
        <select aria-label={t("resource.compare.right")} value={rightRoot} onChange={(event) => setRightRoot(event.target.value)}>
          {dependencyGraph.nodes.map((node) => <option key={node.rootPath} value={node.rootPath}>{node.name}</option>)}
        </select>
        <button className="btn small" type="button" disabled={loading || !leftRoot || !rightRoot || leftRoot === rightRoot} onClick={() => void compare()}>
          {loading ? t("resource.compare.comparing") : t("resource.compare.action")}
        </button>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      {comparison && (
        <>
          <div className="resource-compare-summary">
            {t("resource.compare.summary", { left: comparison.leftName, right: comparison.rightName, count: comparison.totalChanged })}
            {comparison.skippedCredentialFiles > 0 && ` ${t("resource.compare.credentials", { count: comparison.skippedCredentialFiles })}`}
            {comparison.truncated && ` ${t("resource.compare.truncated")}`}
          </div>
          {comparison.totalChanged === 0 ? (
            <div className="operations-empty">{t("resource.compare.identical")}</div>
          ) : (
            <div className="resource-compare-workbench">
              <div className="resource-compare-files">
                {comparison.files.map((file) => (
                  <button
                    type="button"
                    className={selectedPath === file.relativePath ? "active" : ""}
                    key={file.relativePath}
                    onClick={() => setSelectedPath(file.relativePath)}
                  >
                    <span className={`resource-compare-kind ${file.kind}`}>{file.kind === "added" ? "+" : file.kind === "removed" ? "−" : "M"}</span>
                    <span>{file.relativePath}</span>
                  </button>
                ))}
              </div>
              <div className="resource-compare-preview">
                {selected?.previewUnavailable ? (
                  <div className="editor-empty">{t("resource.compare.noPreview")}</div>
                ) : selected ? (
                  <Suspense fallback={<div className="editor-empty">{t("resource.compare.loadingPreview")}</div>}>
                    <ChangeDiff
                      id={`${comparison.leftName}:${comparison.rightName}:${selected.relativePath}`}
                      original={selected.originalContent}
                      modified={selected.modifiedContent}
                      language={languageForPath(selected.relativePath)}
                      fontSize={editorPreferences.fontSize}
                      wordWrap={editorPreferences.wordWrap}
                      resolvedTheme={resolvedTheme}
                      compact
                    />
                  </Suspense>
                ) : null}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface ViewportSectionProps {
  active: boolean;
  clientLabel: string;
}

function ViewportSection({ active, clientLabel }: ViewportSectionProps) {
  const [attachedTitle, setAttachedTitle] = useState<string | null>(null);
  const [detachPending, setDetachPending] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);

  async function detach() {
    if (detachPending) return;
    setDetachPending(true);
    setEmbedError(null);
    try {
      await window.api.windowEmbed.detach();
      setAttachedTitle(null);
    } catch (error) {
      // Keep the attached state visible/actionable when native detach fails.
      setEmbedError((error as Error).message || "Failed to detach the embedded window.");
    } finally {
      setDetachPending(false);
    }
  }

  return (
    <div className="viewport-frame" style={{ flex: 1, minHeight: 0 }}>
      {/* Kept well away from the embed target rect below, on purpose: a raw Win32 child window
          always paints on top of Chromium content in its screen rect — CSS z-index can't help —
          so any control that must stay clickable while attached needs to live structurally
          outside that rect, not just visually above it with a small margin. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
        {attachedTitle && (
          <>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Attached: {attachedTitle}</span>
            <button className="btn small" onClick={() => void detach()} disabled={detachPending}>
              {detachPending ? "Detaching…" : "Detach"}
            </button>
          </>
        )}
      </div>
      {embedError && <div className="error-text" role="alert">{embedError}</div>}
      {attachedTitle ? (
        <EmbedSurface active={active} />
      ) : (
        <EmbedPicker
          clientLabel={clientLabel}
          onAttached={(title) => {
            setEmbedError(null);
            setAttachedTitle(title);
          }}
        />
      )}
    </div>
  );
}

/** Just the measured placeholder for the currently-attached native window — no text, no buttons,
 * nothing that a slightly-imprecise embed rect could end up covering. */
function EmbedSurface({ active }: { active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Measure only when layout can actually change. The old perpetual rAF loop sent 60 IPC calls
  // and repeated SetWindowPos/ShowWindow every second even for a completely static viewport.
  // ResizeObserver covers panel/layout changes; the window event covers DPI and host resizing.
  useEffect(() => {
    if (!active || !containerRef.current) {
      void window.api.windowEmbed.setRect(0, 0, 0, 0, false);
      return;
    }

    const container = containerRef.current;
    let frame: number | null = null;
    let lastMeasurement = "";
    const measure = () => {
      frame = null;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const values = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * dpr));
      const measurement = values.join(":");
      if (measurement === lastMeasurement) return;
      lastMeasurement = measurement;
      void window.api.windowEmbed.setRect(values[0], values[1], values[2], values[3], true);
    };
    const scheduleMeasure = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(container);
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== null) cancelAnimationFrame(frame);
      void window.api.windowEmbed.setRect(0, 0, 0, 0, false);
    };
  }, [active]);

  // Safety net — the authoritative cleanup is main.ts's window-all-closed handler,
  // this just covers the component unmounting while the app stays alive.
  useEffect(() => {
    return () => {
      void window.api.windowEmbed.detach().catch(() => {
        // Component teardown has no remaining UI to recover; main-process
        // window cleanup remains the authoritative safety net.
      });
    };
  }, []);

  return (
    // alignSelf/width here override .viewport-frame's `align-items: center` — without them this
    // flex item has no explicit cross-axis size and shrink-wraps to ~0 width while `flex: 1` still
    // lets it grow tall, which is exactly the "long, very very skinny" box that showed up.
    <div style={{ flex: 1, alignSelf: "stretch", width: "100%", minHeight: 0, border: "1px solid var(--border)", borderRadius: 4, padding: 1 }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

function EmbedPicker({ clientLabel, onAttached }: { clientLabel: string; onAttached: (title: string) => void }) {
  const [candidates, setCandidates] = useState<WindowCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const found = await window.api.windowEmbed.listCandidates();
      setCandidates(found);
      if (found.length === 0) setError(`No ${clientLabel} window found — make sure it's running in windowed/borderless mode, then scan again.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function attachTo(candidate: WindowCandidate) {
    if (attachingId || scanning) return;
    setAttachingId(candidate.id);
    setError(null);
    try {
      const result = await window.api.windowEmbed.attach(candidate.id);
      if (result.ok) onAttached(candidate.title || candidate.processName);
      else setError(result.error ?? "Failed to attach to that window.");
    } catch (attachError) {
      setError((attachError as Error).message || "Failed to attach to that window.");
    } finally {
      setAttachingId(null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button className="btn small primary" onClick={scan} disabled={scanning || attachingId !== null}>
          {scanning ? "Scanning…" : `Scan for ${clientLabel} window`}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {candidates.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {candidates.map((c) => (
            <div
              key={c.id}
              className="tree-node"
              style={{ paddingLeft: 8, opacity: scanning || (attachingId && attachingId !== c.id) ? 0.55 : 1 }}
              aria-disabled={scanning || attachingId !== null}
              onClick={() => { if (!scanning && !attachingId) void attachTo(c); }}
            >
              <span className="icon">🖥</span>
              <span>
                {c.title || "(untitled window)"} — {c.processName} (pid {c.pid})
                {attachingId === c.id ? " — attaching…" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {candidates.length === 0 && !error && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          Docks the real, live {clientLabel} client window into this pane (Windows only).
          Launch it in windowed or borderless mode first, then scan.
        </div>
      )}
    </div>
  );
}
