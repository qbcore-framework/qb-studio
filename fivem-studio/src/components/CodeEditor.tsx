import { useCallback, useEffect, useMemo, useRef } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";

import { ensureUserTheme } from "../monacoSetup";
import { notifyLuaDocumentSaved, useLuaLanguageService, type LuaServiceStatus } from "../luaLanguageService";
import type { OpenFile } from "../App";
import type { EditorPreferences, EditorProblem, ResolvedTheme } from "../global";
import { t } from "../i18n";

function revealEditorPosition(editor: monaco.editor.IStandaloneCodeEditor, line: number, column: number): void {
  requestAnimationFrame(() => {
    editor.setPosition({ lineNumber: line, column });
    editor.revealPositionInCenter({ lineNumber: line, column });
    editor.focus();
  });
}

interface CodeEditorProps {
  file: OpenFile;
  openPaths: string[];
  language: string;
  preferences: EditorPreferences;
  resolvedTheme: ResolvedTheme;
  luaActive: boolean;
  reveal: { path: string; line: number; column: number; nonce: number } | null;
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string, expectedRevision: string) => Promise<void>;
  onSelectionChange: (selectedText: string, startLine: number, endLine: number) => void;
  onProblemsChange: (path: string, problems: EditorProblem[]) => void;
  onOpenLocation: (path: string, line: number, column: number) => void;
  onLuaStatusChange: (status: LuaServiceStatus, message?: string) => void;
  onAgentPrompt: (text: string) => void;
  resourceNames: string[];
  bookmarkLines: number[];
  onToggleBookmark: (path: string, line: number) => void;
}

const SERVER_CFG_DOCS: Record<string, { detail: string; insertText: string }> = {
  sv_maxclients: {
    detail: "Maximum simultaneous client slots accepted by FXServer.",
    insertText: "sv_maxclients ${1:48}",
  },
  sv_licenseKey: {
    detail: "Cfx.re server license key. Keep the real value in an exec-loaded credential file.",
    insertText: "sv_licenseKey \"${1:key}\"",
  },
  endpoint_add_tcp: {
    detail: "Adds the TCP game endpoint. Local development commonly uses port 30120.",
    insertText: "endpoint_add_tcp \"${1:127.0.0.1}:${2:30120}\"",
  },
  endpoint_add_udp: {
    detail: "Adds the UDP game endpoint. It normally matches the TCP endpoint port.",
    insertText: "endpoint_add_udp \"${1:127.0.0.1}:${2:30120}\"",
  },
  sv_hostname: {
    detail: "Human-readable server name shown by Cfx.re clients.",
    insertText: "sv_hostname \"${1:QB Studio Development}\"",
  },
  ensure: {
    detail: "Starts a resource if stopped, or restarts it if already running.",
    insertText: "ensure ${1:resource-name}",
  },
};

// Split editors can share Monaco models. Reference-count each mounted editor's
// interest so closing the final tab disposes the final model without one split
// accidentally disposing a model that the other split still renders.
const modelOwners = new Map<string, number>();

function modelKey(monacoInstance: typeof monaco, path: string): string {
  return monacoInstance.Uri.file(path).toString(true).toLowerCase();
}

function retainModel(monacoInstance: typeof monaco, path: string): void {
  const key = modelKey(monacoInstance, path);
  modelOwners.set(key, (modelOwners.get(key) ?? 0) + 1);
}

function releaseModel(monacoInstance: typeof monaco, path: string): void {
  const key = modelKey(monacoInstance, path);
  const owners = modelOwners.get(key) ?? 0;
  if (owners > 1) {
    modelOwners.set(key, owners - 1);
    return;
  }
  modelOwners.delete(key);
  monacoInstance.editor.getModel(monacoInstance.Uri.file(path))?.dispose();
}

function severityName(severity: number): EditorProblem["severity"] {
  // Monaco's marker severities are bit flags ordered Hint=1 through Error=8.
  if (severity >= 8) return "error";
  if (severity >= 4) return "warning";
  if (severity >= 2) return "info";
  return "hint";
}

export default function CodeEditor({
  file,
  openPaths,
  language,
  preferences,
  resolvedTheme,
  luaActive,
  reveal,
  onChange,
  onSave,
  onSelectionChange,
  onProblemsChange,
  onOpenLocation,
  onLuaStatusChange,
  onAgentPrompt,
  resourceNames,
  bookmarkLines,
  onToggleBookmark,
}: CodeEditorProps) {
  const monacoInstance = useMonaco();
  const luaStatus = useLuaLanguageService(luaActive, preferences.luaIntelligence);
  const fileRef = useRef(file);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onProblemsChangeRef = useRef(onProblemsChange);
  const onOpenLocationRef = useRef(onOpenLocation);
  const onAgentPromptRef = useRef(onAgentPrompt);
  const onToggleBookmarkRef = useRef(onToggleBookmark);
  const preferencesRef = useRef(preferences);
  const resourceNamesRef = useRef(resourceNames);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorDisposablesRef = useRef<monaco.IDisposable[]>([]);
  const bookmarkDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const trackedPathsRef = useRef(new Set<string>());
  fileRef.current = file;
  onSaveRef.current = onSave;
  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;
  onProblemsChangeRef.current = onProblemsChange;
  onOpenLocationRef.current = onOpenLocation;
  onAgentPromptRef.current = onAgentPrompt;
  onToggleBookmarkRef.current = onToggleBookmark;
  preferencesRef.current = preferences;
  resourceNamesRef.current = resourceNames;

  const handleChange = useCallback((value: string | undefined) => {
    onChangeRef.current(fileRef.current.path, value ?? "");
  }, []);

  const publishProblems = useCallback((path: string) => {
    if (!monacoInstance) return;
    const model = monacoInstance.editor.getModel(monaco.Uri.file(path));
    if (!model) return;
    const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
    onProblemsChangeRef.current(path, markers.map((marker) => ({
      path,
      severity: severityName(marker.severity),
      message: marker.message,
      line: marker.startLineNumber,
      column: marker.startColumn,
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
      source: marker.source,
      code: marker.code === undefined ? undefined : String(marker.code),
    })));
  }, [monacoInstance]);

  const options = useMemo(() => ({
    minimap: { enabled: preferences.minimap },
    fontSize: preferences.fontSize,
    wordWrap: preferences.wordWrap ? "on" as const : "off" as const,
    stickyScroll: { enabled: preferences.stickyScroll },
    automaticLayout: true,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    "semanticHighlighting.enabled": true,
    renderWhitespace: "selection" as const,
    smoothScrolling: true,
    glyphMargin: true,
  }), [preferences]);
  const editorPath = useMemo(() => monaco.Uri.file(file.path).toString(true), [file.path]);

  useEffect(() => {
    onLuaStatusChange(luaStatus.state, luaStatus.message);
  }, [luaStatus, onLuaStatusChange]);

  // @monaco-editor/react can keep one model per path, which preserves undo,
  // cursor, folds, and language-service state while switching tabs. Dispose a
  // model as soon as its tab closes so large workspaces do not accumulate RAM.
  useEffect(() => {
    if (!monacoInstance) return;
    const current = new Set(openPaths);
    for (const previous of trackedPathsRef.current) {
      if (!current.has(previous)) releaseModel(monacoInstance, previous);
    }
    for (const path of current) if (!trackedPathsRef.current.has(path)) retainModel(monacoInstance, path);
    trackedPathsRef.current = current;
  }, [monacoInstance, openPaths]);

  useEffect(() => {
    if (!monacoInstance) return;
    return () => {
      for (const path of trackedPathsRef.current) releaseModel(monacoInstance, path);
      trackedPathsRef.current.clear();
    };
  }, [monacoInstance]);

  useEffect(() => {
    if (!monacoInstance) return;
    for (const path of openPaths) publishProblems(path);
    const disposable = monacoInstance.editor.onDidChangeMarkers((resources) => {
      const changed = new Set(resources.map((resource) => resource.toString(true).toLowerCase()));
      for (const path of trackedPathsRef.current) {
        if (changed.has(monacoInstance.Uri.file(path).toString(true).toLowerCase())) publishProblems(path);
      }
    });
    return () => disposable.dispose();
  }, [monacoInstance, openPaths, publishProblems]);

  useEffect(() => {
    return () => {
      for (const disposable of editorDisposablesRef.current) disposable.dispose();
      editorDisposablesRef.current = [];
      bookmarkDecorationsRef.current?.clear();
      bookmarkDecorationsRef.current = null;
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!reveal || reveal.path !== file.path || !editorRef.current) return;
    revealEditorPosition(editorRef.current, reveal.line, reveal.column);
  }, [file.path, reveal]);

  useEffect(() => {
    bookmarkDecorationsRef.current?.set(bookmarkLines.map((line) => ({
      range: {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: 1,
      },
      options: { isWholeLine: true, glyphMarginClassName: "editor-bookmark-glyph" },
    })));
  }, [bookmarkLines, file.path]);

  return (
    <Editor
      path={editorPath}
      language={language}
      value={file.content}
      theme={ensureUserTheme(resolvedTheme)}
      keepCurrentModel
      onChange={handleChange}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        if (reveal?.path === file.path) revealEditorPosition(editor, reveal.line, reveal.column);
        bookmarkDecorationsRef.current = editor.createDecorationsCollection(bookmarkLines.map((line) => ({
          range: new monaco.Range(line, 1, line, 1),
          options: { isWholeLine: true, glyphMarginClassName: "editor-bookmark-glyph" },
        })));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void (async () => {
            if (preferencesRef.current.formatOnSave) {
              const format = editor.getAction("editor.action.formatDocument");
              if (format?.isSupported()) await format.run();
            }
            const current = fileRef.current;
            await onSaveRef.current(current.path, editor.getValue(), current.revision);
            notifyLuaDocumentSaved(editor.getModel());
          })().catch(() => {
            // App owns the visible error banner; avoid an unhandled command promise.
          });
        });

        editorDisposablesRef.current.push(editor.onDidChangeCursorSelection((event) => {
          const selected = editor.getModel()?.getValueInRange(event.selection) ?? "";
          onSelectionChangeRef.current(selected, event.selection.startLineNumber, event.selection.endLineNumber);
        }));
        editorDisposablesRef.current.push(editor.addAction({
          id: "qb-studio.toggle-bookmark",
          label: t("bookmarks.toggle"),
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyK],
          contextMenuGroupId: "navigation",
          contextMenuOrder: 1,
          run: () => {
            const position = editor.getPosition();
            if (position) onToggleBookmarkRef.current(fileRef.current.path, position.lineNumber);
          },
        }));
        const promptForSelection = (instruction: string) => {
          const selection = editor.getSelection();
          const selected = selection ? editor.getModel()?.getValueInRange(selection).trim() : "";
          if (!selection || !selected) return;
          const current = fileRef.current;
          onSelectionChangeRef.current(selected, selection.startLineNumber, selection.endLineNumber);
          onAgentPromptRef.current(`${instruction} The selection is in ${current.path.split(/[/\\]/).pop()}, lines ${selection.startLineNumber}–${selection.endLineNumber}.`);
        };
        editorDisposablesRef.current.push(editor.addAction({
          id: "qb-studio.ask-agent-selection",
          label: t("agent.selection.ask"),
          precondition: "editorHasSelection",
          contextMenuGroupId: "9_cutcopypaste",
          contextMenuOrder: 3,
          run: () => promptForSelection("Help me with the selected code. Ask a concise clarifying question if the desired outcome is ambiguous."),
        }));
        editorDisposablesRef.current.push(editor.addAction({
          id: "qb-studio.explain-selection",
          label: t("agent.selection.explain"),
          precondition: "editorHasSelection",
          contextMenuGroupId: "9_cutcopypaste",
          contextMenuOrder: 4,
          run: () => promptForSelection("Explain the selected code, its role in this resource, and any important FiveM, RedM, or QBCore behavior it relies on."),
        }));
        editorDisposablesRef.current.push(editor.addAction({
          id: "qb-studio.error-handling-selection",
          label: t("agent.selection.errorHandling"),
          precondition: "editorHasSelection",
          contextMenuGroupId: "9_cutcopypaste",
          contextMenuOrder: 5,
          run: () => promptForSelection("Add appropriate error handling around the selected code. Preserve existing behavior and explain the failure cases you cover before editing."),
        }));
        const isServerCfg = (model: monaco.editor.ITextModel) => model.uri.path.split("/").pop()?.toLowerCase() === "server.cfg";
        editorDisposablesRef.current.push(monaco.languages.registerCompletionItemProvider("ini", {
          triggerCharacters: [" "],
          provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position) {
            if (!isServerCfg(model)) return { suggestions: [] };
            const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
            const ensureLine = /^\s*ensure\s+/i.test(line);
            if (ensureLine) {
              return {
                suggestions: resourceNamesRef.current.map((name) => ({
                  label: name,
                  kind: monaco.languages.CompletionItemKind.Module,
                  detail: "Workspace resource",
                  insertText: name,
                  range,
                })),
              };
            }
            return {
              suggestions: Object.entries(SERVER_CFG_DOCS).map(([label, value]) => ({
                label,
                kind: monaco.languages.CompletionItemKind.Property,
                detail: value.detail,
                documentation: { value: value.detail },
                insertText: value.insertText,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range,
              })),
            };
          },
        }));
        editorDisposablesRef.current.push(monaco.languages.registerHoverProvider("ini", {
          provideHover(model: monaco.editor.ITextModel, position: monaco.Position) {
            if (!isServerCfg(model)) return null;
            const line = model.getLineContent(position.lineNumber);
            const command = line.trim().split(/\s+/, 1)[0];
            const documentation = SERVER_CFG_DOCS[command];
            if (documentation) return { contents: [{ value: `**${command}**` }, { value: documentation.detail }] };
            const ensured = line.match(/^\s*ensure\s+(\S+)/i)?.[1];
            if (ensured && resourceNamesRef.current.some((name) => name.toLowerCase() === ensured.toLowerCase())) {
              return { contents: [{ value: `**${ensured}**` }, { value: "Workspace resource started by this configuration line." }] };
            }
            return null;
          },
        }));
        editorDisposablesRef.current.push(monaco.editor.registerEditorOpener({
          openCodeEditor(
            _source: monaco.editor.ICodeEditor,
            resource: monaco.Uri,
            selectionOrPosition?: monaco.IRange | monaco.IPosition,
          ) {
            if (resource.scheme !== "file") return false;
            const line = selectionOrPosition && "startLineNumber" in selectionOrPosition
              ? selectionOrPosition.startLineNumber
              : selectionOrPosition?.lineNumber ?? 1;
            const column = selectionOrPosition && "startColumn" in selectionOrPosition
              ? selectionOrPosition.startColumn
              : selectionOrPosition?.column ?? 1;
            onOpenLocationRef.current(resource.fsPath, line, column);
            return true;
          },
        }));
      }}
      options={options}
    />
  );
}
