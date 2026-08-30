import { useEffect, useState } from "react";
import * as monaco from "monaco-editor/editor";

import type { CfxTarget } from "./global";

export type LuaServiceStatus = "off" | "starting" | "ready" | "stopped" | "error";

type JsonObject = Record<string, unknown>;
type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toLspPosition(position: monaco.Position): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toLspRange(range: monaco.IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

function fromLspRange(value: unknown): monaco.Range {
  const range = value as LspRange;
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

function modelUri(model: monaco.editor.ITextModel): string {
  return model.uri.toString(true);
}

function textDocumentPosition(model: monaco.editor.ITextModel, position: monaco.Position) {
  return { textDocument: { uri: modelUri(model) }, position: toLspPosition(position) };
}

function markdown(value: unknown): monaco.IMarkdownString | undefined {
  if (typeof value === "string") return { value };
  if (!isObject(value)) return undefined;
  if (typeof value.language === "string" && typeof value.value === "string") {
    return { value: `\n\n\`\`\`${value.language}\n${value.value}\n\`\`\`` };
  }
  if (typeof value.value === "string") {
    return { value: value.kind === "plaintext" ? value.value.replaceAll("\\", "\\\\") : value.value };
  }
  return undefined;
}

function hoverContents(value: unknown): monaco.IMarkdownString[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    const converted = markdown(entry);
    return converted ? [converted] : [];
  });
}

const COMPLETION_KINDS: monaco.languages.CompletionItemKind[] = [
  monaco.languages.CompletionItemKind.Text,
  monaco.languages.CompletionItemKind.Method,
  monaco.languages.CompletionItemKind.Function,
  monaco.languages.CompletionItemKind.Constructor,
  monaco.languages.CompletionItemKind.Field,
  monaco.languages.CompletionItemKind.Variable,
  monaco.languages.CompletionItemKind.Class,
  monaco.languages.CompletionItemKind.Interface,
  monaco.languages.CompletionItemKind.Module,
  monaco.languages.CompletionItemKind.Property,
  monaco.languages.CompletionItemKind.Unit,
  monaco.languages.CompletionItemKind.Value,
  monaco.languages.CompletionItemKind.Enum,
  monaco.languages.CompletionItemKind.Keyword,
  monaco.languages.CompletionItemKind.Snippet,
  monaco.languages.CompletionItemKind.Color,
  monaco.languages.CompletionItemKind.File,
  monaco.languages.CompletionItemKind.Reference,
  monaco.languages.CompletionItemKind.Folder,
  monaco.languages.CompletionItemKind.EnumMember,
  monaco.languages.CompletionItemKind.Constant,
  monaco.languages.CompletionItemKind.Struct,
  monaco.languages.CompletionItemKind.Event,
  monaco.languages.CompletionItemKind.Operator,
  monaco.languages.CompletionItemKind.TypeParameter,
];

function completionKind(value: unknown): monaco.languages.CompletionItemKind {
  return typeof value === "number" ? COMPLETION_KINDS[value - 1] ?? monaco.languages.CompletionItemKind.Text : monaco.languages.CompletionItemKind.Text;
}

function textEdit(value: unknown): monaco.languages.TextEdit | null {
  if (!isObject(value) || typeof value.newText !== "string" || !isObject(value.range)) return null;
  return { range: fromLspRange(value.range), text: value.newText };
}

function asLocation(value: unknown): monaco.languages.Location | null {
  if (!isObject(value) || typeof value.uri !== "string" || !isObject(value.range)) return null;
  return { uri: monaco.Uri.parse(value.uri), range: fromLspRange(value.range) };
}

function locationList(value: unknown): monaco.languages.Location[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((entry) => {
    if (isObject(entry) && typeof entry.targetUri === "string" && isObject(entry.targetSelectionRange)) {
      return [{ uri: monaco.Uri.parse(entry.targetUri), range: fromLspRange(entry.targetSelectionRange) }];
    }
    const location = asLocation(entry);
    return location ? [location] : [];
  });
}

const CFXLUA_NONSTANDARD_SYMBOLS = ["`", "/**/", "+=", "-=", "*=", "/=", "<<=", ">>=", "&=", "|=", "^="];

function luaSettings(
  mode: "balanced" | "full",
  libraryRoots: string[],
  pluginPath: string,
  target: CfxTarget,
): JsonObject {
  const full = mode === "full";
  return {
    addonManager: { enable: false },
    completion: { callSnippet: "Replace", keywordSnippet: "Replace", showWord: "Fallback", workspaceWord: true },
    diagnostics: {
      globals: [...(target === "redm" ? [] : ["QBCore"]), "Citizen", "exports", "source", "json", "promise", "lib"],
      libraryFiles: "Disable",
      workspaceDelay: full ? 1_500 : 4_000,
      workspaceEvent: "OnSave",
      workspaceRate: full ? 100 : 25,
    },
    format: { enable: true, defaultConfig: { indent_style: "space", indent_size: "4", quote_style: "single" } },
    hint: { enable: full, paramName: "Literal", setType: false },
    runtime: {
      version: "Lua 5.4",
      nonstandardSymbol: CFXLUA_NONSTANDARD_SYMBOLS,
      plugin: pluginPath,
      path: ["?.lua", "?/init.lua", "?/shared.lua", "?/client.lua", "?/server.lua"],
      pathStrict: false,
    },
    semantic: { enable: true, variable: true },
    signatureHelp: { enable: true },
    workspace: {
      checkThirdParty: "Disable",
      ignoreDir: [".git", "node_modules", "cache", "logs", "crashes", "txData"],
      ignoreSubmodules: true,
      library: libraryRoots,
      maxPreload: full ? 10_000 : 2_000,
      preloadFileSize: full ? 2_000 : 500,
      useGitIgnore: true,
    },
  };
}

class LuaLanguageClient {
  private nextId = 1;
  private generation = 0;
  private active = false;
  private ready = false;
  private workspaceUri = "";
  private workspaceName = "QB Studio";
  private settings: JsonObject = {};
  private capabilities: JsonObject = {};
  private openedUris = new Set<string>();
  private status: LuaServiceStatus = "stopped";
  private statusMessage: string | undefined;
  private subscribers = new Set<(status: LuaServiceStatus, message?: string) => void>();
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }>();
  private modelDisposables = new Map<monaco.editor.ITextModel, monaco.IDisposable[]>();

  constructor() {
    window.api.lua.onMessage((message) => this.receive(message));
    window.api.lua.onStatus((status) => {
      if (status.state === "error") this.setStatus("error", status.message);
      else if (this.active) this.setStatus("stopped", status.message);
    });
    this.registerProviders();
    for (const model of monaco.editor.getModels()) this.trackModel(model);
    monaco.editor.onDidCreateModel((model) => this.trackModel(model));
    monaco.editor.onDidChangeModelLanguage(({ model }) => this.reconcileModel(model));
  }

  subscribe(callback: (status: LuaServiceStatus, message?: string) => void): () => void {
    this.subscribers.add(callback);
    callback(this.status, this.statusMessage);
    return () => this.subscribers.delete(callback);
  }

  private setStatus(status: LuaServiceStatus, message?: string) {
    this.status = status;
    this.statusMessage = message;
    for (const subscriber of this.subscribers) subscriber(status, message);
  }

  async start(mode: "off" | "balanced" | "full", expectedTarget: CfxTarget): Promise<void> {
    const generation = ++this.generation;
    this.resetConnection();
    await window.api.lua.stop();
    if (generation !== this.generation) return;
    if (mode === "off") {
      this.setStatus("off");
      return;
    }
    this.active = true;
    this.setStatus("starting");
    try {
      const session = await window.api.lua.start();
      if (generation !== this.generation) return;
      if (!session.ok) throw new Error(session.error);
      if (session.target !== expectedTarget) {
        throw new Error(`Lua definition target changed while starting (${expectedTarget} to ${session.target}).`);
      }
      this.workspaceUri = monaco.Uri.file(session.workspaceRoot).toString(true);
      this.workspaceName = session.workspaceRoot.split(/[/\\]/).pop() || "QB Studio";
      this.settings = luaSettings(session.mode, session.libraryRoots, session.pluginPath, session.target);
      const initialized = await this.request("initialize", {
        processId: null,
        clientInfo: { name: "QB Studio", version: "1" },
        rootUri: this.workspaceUri,
        workspaceFolders: [{ uri: this.workspaceUri, name: this.workspaceName }],
        initializationOptions: { changeConfiguration: true },
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { applyEdit: true, configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                deprecatedSupport: true,
                insertReplaceSupport: true,
              },
              contextSupport: true,
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } } },
            definition: { linkSupport: true },
            references: {},
            rename: { prepareSupport: true },
            formatting: {},
            publishDiagnostics: { relatedInformation: true, versionSupport: true, codeDescriptionSupport: true },
          },
          window: { workDoneProgress: true },
        },
      });
      if (generation !== this.generation) return;
      this.capabilities = isObject(initialized) && isObject(initialized.capabilities) ? initialized.capabilities : {};
      this.notify("initialized", {});
      this.notify("workspace/didChangeConfiguration", { settings: { Lua: this.settings } });
      this.ready = true;
      for (const model of monaco.editor.getModels()) this.reconcileModel(model);
      this.setStatus("ready", `LuaLS ${session.version}`);
    } catch (error) {
      if (generation !== this.generation) return;
      this.active = false;
      this.setStatus("error", (error as Error).message);
      void window.api.lua.stop();
    }
  }

  stop(): void {
    this.generation += 1;
    this.resetConnection();
    this.setStatus("stopped");
    void window.api.lua.stop();
  }

  saved(model: monaco.editor.ITextModel | null): void {
    if (!model || !this.ready || model.getLanguageId() !== "lua" || !this.openedUris.has(modelUri(model))) return;
    this.notify("textDocument/didSave", { textDocument: { uri: modelUri(model) }, text: model.getValue() });
  }

  private resetConnection() {
    this.active = false;
    this.ready = false;
    this.capabilities = {};
    this.openedUris.clear();
    for (const { reject, timer } of this.pending.values()) {
      window.clearTimeout(timer);
      reject(new Error("Lua language service stopped."));
    }
    this.pending.clear();
    for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, "lua-language-server", []);
  }

  private trackModel(model: monaco.editor.ITextModel) {
    if (this.modelDisposables.has(model)) return;
    const disposables = [
      model.onDidChangeContent((event) => {
        const uri = modelUri(model);
        if (!this.ready || model.getLanguageId() !== "lua" || !this.openedUris.has(uri)) return;
        this.notify("textDocument/didChange", {
          textDocument: { uri, version: model.getVersionId() },
          contentChanges: event.changes.map((change) => ({
            range: toLspRange(change.range),
            rangeLength: change.rangeLength,
            text: change.text,
          })),
        });
      }),
      model.onWillDispose(() => {
        const uri = modelUri(model);
        if (this.ready && this.openedUris.delete(uri)) this.notify("textDocument/didClose", { textDocument: { uri } });
        for (const disposable of this.modelDisposables.get(model) ?? []) disposable.dispose();
        this.modelDisposables.delete(model);
      }),
    ];
    this.modelDisposables.set(model, disposables);
    this.reconcileModel(model);
  }

  private reconcileModel(model: monaco.editor.ITextModel) {
    if (!this.ready || model.isDisposed()) return;
    const uri = modelUri(model);
    if (model.getLanguageId() === "lua") {
      if (!this.openedUris.has(uri)) {
        this.openedUris.add(uri);
        this.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "lua", version: model.getVersionId(), text: model.getValue() },
        });
      }
    } else if (this.openedUris.delete(uri)) {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }
  }

  private notify(method: string, params: unknown) {
    if (!this.active) return;
    window.api.lua.send({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.active) return Promise.reject(new Error("Lua language service is not active."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LuaLS timed out while handling ${method}.`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      window.api.lua.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private respond(id: string | number, result: unknown, error?: JsonObject) {
    window.api.lua.send(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
  }

  private receive(value: unknown) {
    if (!this.active || !isObject(value) || value.jsonrpc !== "2.0") return;
    if ((typeof value.id === "number" || typeof value.id === "string") && typeof value.method !== "string") {
      if (typeof value.id !== "number") return;
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      window.clearTimeout(pending.timer);
      if (isObject(value.error)) pending.reject(new Error(String(value.error.message ?? "LuaLS request failed.")));
      else pending.resolve(value.result);
      return;
    }
    if (typeof value.method !== "string") return;
    if (value.method === "textDocument/publishDiagnostics") {
      this.publishDiagnostics(value.params);
      return;
    }
    if (typeof value.id !== "number" && typeof value.id !== "string") return;
    const params = isObject(value.params) ? value.params : {};
    if (value.method === "workspace/configuration") {
      const items = Array.isArray(params.items) ? params.items : [];
      this.respond(value.id, items.map((item) => {
        if (!isObject(item) || typeof item.section !== "string") return null;
        if (item.section === "Lua") return this.settings;
        if (!item.section.startsWith("Lua.")) return null;
        return item.section.slice(4).split(".").reduce<unknown>((current, key) => isObject(current) ? current[key] : undefined, this.settings) ?? null;
      }));
    } else if (value.method === "workspace/workspaceFolders") {
      this.respond(value.id, [{ uri: this.workspaceUri, name: this.workspaceName }]);
    } else if (
      value.method === "client/registerCapability" ||
      value.method === "client/unregisterCapability" ||
      value.method === "window/workDoneProgress/create" ||
      value.method.endsWith("/refresh")
    ) {
      this.respond(value.id, null);
    } else {
      this.respond(value.id, null, { code: -32601, message: `QB Studio does not implement ${value.method}.` });
    }
  }

  private publishDiagnostics(value: unknown) {
    if (!isObject(value) || typeof value.uri !== "string") return;
    const wanted = value.uri.toLowerCase();
    const model = monaco.editor.getModels().find((candidate) => modelUri(candidate).toLowerCase() === wanted);
    if (!model) return;
    const markers = (Array.isArray(value.diagnostics) ? value.diagnostics : []).flatMap((item) => {
      if (!isObject(item) || typeof item.message !== "string" || !isObject(item.range)) return [];
      const range = fromLspRange(item.range);
      const severity = item.severity === 1
        ? monaco.MarkerSeverity.Error
        : item.severity === 2
          ? monaco.MarkerSeverity.Warning
          : item.severity === 3
            ? monaco.MarkerSeverity.Info
            : monaco.MarkerSeverity.Hint;
      return [{
        severity,
        message: item.message,
        source: typeof item.source === "string" ? item.source : "LuaLS",
        code: typeof item.code === "string" || typeof item.code === "number" ? String(item.code) : undefined,
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn,
      }];
    });
    monaco.editor.setModelMarkers(model, "lua-language-server", markers);
  }

  private supports(name: string): boolean {
    return this.ready && Boolean(this.capabilities[name]);
  }

  private registerProviders() {
    monaco.languages.registerCompletionItemProvider("lua", {
      triggerCharacters: [".", ":", "'", "\"", "[", "/", "@"],
      provideCompletionItems: async (model, position, context) => {
        if (!this.supports("completionProvider")) return { suggestions: [] };
        const response = await this.request("textDocument/completion", {
          ...textDocumentPosition(model, position),
          context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
        }).catch(() => null);
        const rawItems = Array.isArray(response) ? response : isObject(response) && Array.isArray(response.items) ? response.items : [];
        const word = model.getWordUntilPosition(position);
        const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const suggestions = rawItems.flatMap((raw): monaco.languages.CompletionItem[] => {
          if (!isObject(raw) || (typeof raw.label !== "string" && !isObject(raw.label))) return [];
          const label = typeof raw.label === "string" ? raw.label : String(raw.label.label ?? "");
          if (!label) return [];
          const edit = isObject(raw.textEdit) ? raw.textEdit : null;
          const editRange = edit && isObject(edit.range) ? fromLspRange(edit.range) : defaultRange;
          const insertText = edit && typeof edit.newText === "string"
            ? edit.newText
            : typeof raw.insertText === "string" ? raw.insertText : label;
          return [{
            label,
            kind: completionKind(raw.kind),
            detail: typeof raw.detail === "string" ? raw.detail : undefined,
            documentation: markdown(raw.documentation),
            sortText: typeof raw.sortText === "string" ? raw.sortText : undefined,
            filterText: typeof raw.filterText === "string" ? raw.filterText : undefined,
            preselect: raw.preselect === true,
            insertText,
            insertTextRules: raw.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range: editRange,
            commitCharacters: Array.isArray(raw.commitCharacters) ? raw.commitCharacters.filter((entry): entry is string => typeof entry === "string") : undefined,
            additionalTextEdits: Array.isArray(raw.additionalTextEdits)
              ? raw.additionalTextEdits.flatMap((entry) => { const converted = textEdit(entry); return converted ? [converted] : []; })
              : undefined,
          }];
        });
        return { suggestions, incomplete: isObject(response) && response.isIncomplete === true };
      },
    });
    monaco.languages.registerHoverProvider("lua", {
      provideHover: async (model, position) => {
        if (!this.supports("hoverProvider")) return null;
        const response = await this.request("textDocument/hover", textDocumentPosition(model, position)).catch(() => null);
        if (!isObject(response)) return null;
        return { contents: hoverContents(response.contents), range: isObject(response.range) ? fromLspRange(response.range) : undefined };
      },
    });
    monaco.languages.registerSignatureHelpProvider("lua", {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp: async (model, position, _token, context) => {
        if (!this.supports("signatureHelpProvider")) return null;
        const response = await this.request("textDocument/signatureHelp", {
          ...textDocumentPosition(model, position),
          context: {
            triggerKind: context.triggerKind + 1,
            triggerCharacter: context.triggerCharacter,
            isRetrigger: context.isRetrigger,
          },
        }).catch(() => null);
        if (!isObject(response) || !Array.isArray(response.signatures)) return null;
        return {
          value: {
            signatures: response.signatures.flatMap((signature) => {
              if (!isObject(signature) || typeof signature.label !== "string") return [];
              return [{
                label: signature.label,
                documentation: markdown(signature.documentation),
                parameters: Array.isArray(signature.parameters) ? signature.parameters.flatMap((parameter) => {
                  if (!isObject(parameter) || (!Array.isArray(parameter.label) && typeof parameter.label !== "string")) return [];
                  return [{ label: parameter.label as string | [number, number], documentation: markdown(parameter.documentation) }];
                }) : [],
                activeParameter: typeof signature.activeParameter === "number" ? signature.activeParameter : undefined,
              }];
            }),
            activeSignature: typeof response.activeSignature === "number" ? response.activeSignature : 0,
            activeParameter: typeof response.activeParameter === "number" ? response.activeParameter : 0,
          },
          dispose() {},
        };
      },
    });
    monaco.languages.registerDefinitionProvider("lua", {
      provideDefinition: async (model, position) => {
        if (!this.supports("definitionProvider")) return null;
        return locationList(await this.request("textDocument/definition", textDocumentPosition(model, position)).catch(() => null));
      },
    });
    monaco.languages.registerReferenceProvider("lua", {
      provideReferences: async (model, position, context) => {
        if (!this.supports("referencesProvider")) return null;
        return locationList(await this.request("textDocument/references", {
          ...textDocumentPosition(model, position),
          context: { includeDeclaration: context.includeDeclaration },
        }).catch(() => null));
      },
    });
    monaco.languages.registerRenameProvider("lua", {
      resolveRenameLocation: async (model, position) => {
        if (!this.supports("renameProvider")) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "Lua rename is unavailable." };
        const response = await this.request("textDocument/prepareRename", textDocumentPosition(model, position)).catch(() => null);
        if (!isObject(response)) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "This symbol cannot be renamed." };
        const range = isObject(response.range) ? fromLspRange(response.range) : fromLspRange(response);
        return { range, text: typeof response.placeholder === "string" ? response.placeholder : model.getValueInRange(range) };
      },
      provideRenameEdits: async (model, position, newName) => {
        if (!this.supports("renameProvider")) return { edits: [], rejectReason: "Lua rename is unavailable." };
        const response = await this.request("textDocument/rename", { ...textDocumentPosition(model, position), newName }).catch(() => null);
        if (!isObject(response)) return { edits: [], rejectReason: "LuaLS could not rename this symbol." };
        const edits: monaco.languages.IWorkspaceTextEdit[] = [];
        if (isObject(response.changes)) {
          for (const [uri, changes] of Object.entries(response.changes)) {
            if (!Array.isArray(changes)) continue;
            for (const change of changes) {
              const converted = textEdit(change);
              if (converted) edits.push({ resource: monaco.Uri.parse(uri), textEdit: converted, versionId: undefined });
            }
          }
        }
        if (Array.isArray(response.documentChanges)) {
          for (const documentChange of response.documentChanges) {
            if (!isObject(documentChange) || !isObject(documentChange.textDocument) || typeof documentChange.textDocument.uri !== "string" || !Array.isArray(documentChange.edits)) continue;
            for (const change of documentChange.edits) {
              const converted = textEdit(change);
              if (converted) edits.push({ resource: monaco.Uri.parse(documentChange.textDocument.uri), textEdit: converted, versionId: undefined });
            }
          }
        }
        return { edits };
      },
    });
    monaco.languages.registerDocumentFormattingEditProvider("lua", {
      provideDocumentFormattingEdits: async (model, options) => {
        if (!this.supports("documentFormattingProvider")) return [];
        const response = await this.request("textDocument/formatting", {
          textDocument: { uri: modelUri(model) },
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        }).catch(() => null);
        return Array.isArray(response) ? response.flatMap((entry) => { const converted = textEdit(entry); return converted ? [converted] : []; }) : [];
      },
    });
  }
}

let singleton: LuaLanguageClient | null = null;
let activeConsumers = 0;
let activeSessionKey: string | null = null;

function client(): LuaLanguageClient {
  singleton ??= new LuaLanguageClient();
  return singleton;
}

export function useLuaLanguageService(active: boolean, mode: "off" | "balanced" | "full", target: CfxTarget) {
  const [status, setStatus] = useState<{ state: LuaServiceStatus; message?: string }>({ state: mode === "off" ? "off" : "stopped" });
  useEffect(() => client().subscribe((state, message) => setStatus({ state, message })), []);
  useEffect(() => {
    if (!active) return;
    activeConsumers += 1;
    const sessionKey = `${mode}:${target}`;
    if (activeSessionKey !== sessionKey) {
      activeSessionKey = sessionKey;
      void client().start(mode, target);
    }
    return () => {
      activeConsumers = Math.max(0, activeConsumers - 1);
      if (activeConsumers === 0) {
        activeSessionKey = null;
        client().stop();
      }
    };
  }, [active, mode, target]);
  return status;
}

export function notifyLuaDocumentSaved(model: monaco.editor.ITextModel | null) {
  singleton?.saved(model);
}
