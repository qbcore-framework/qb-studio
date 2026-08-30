import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { LuaLanguageServerProcess, type JsonRpcMessage } from "./luaLanguageServer";

const bundledLuaLs = path.resolve(__dirname, "..", "..", "vendor", "lua-language-server", "bin", "lua-language-server.exe");
const libraryRoot = path.resolve(__dirname, "..", "resources", "lua-library");
const packRoots = {
  fivem: path.join(libraryRoot, "fivem"),
  redm: path.join(libraryRoot, "redm"),
  qbcore: path.join(libraryRoot, "qbcore"),
};
const packsReady = Object.values(packRoots).every((packRoot) => fs.existsSync(packRoot));
const bundledPlugin = path.join(libraryRoot, "plugin.lua");

type CompletionItem = {
  label?: string | { label?: unknown; detail?: unknown; description?: unknown };
  filterText?: unknown;
  insertText?: unknown;
  textEdit?: { newText?: unknown };
};

function completionItems(value: unknown): CompletionItem[] {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : [];
  return items.filter((item): item is CompletionItem => Boolean(item && typeof item === "object"));
}

function completionLabel(item: CompletionItem): string {
  if (typeof item.label === "string") return item.label;
  return item.label && typeof item.label.label === "string" ? item.label.label : "";
}

// LuaLS versions can return either a plain symbol label or a label decorated
// with a callable signature. filterText/insertText remain useful fallbacks.
function completionHasSymbol(items: CompletionItem[], symbol: string): boolean {
  return items.some((item) => {
    const candidates = [
      completionLabel(item),
      typeof item.filterText === "string" ? item.filterText : "",
      typeof item.insertText === "string" ? item.insertText : "",
      typeof item.textEdit?.newText === "string" ? item.textEdit.newText : "",
    ];
    return candidates.some((candidate) => candidate === symbol || candidate.startsWith(`${symbol}(`));
  });
}

function positionAtMarker(source: string): { text: string; position: { line: number; character: number } } {
  const marker = source.indexOf("|");
  assert.notEqual(marker, -1, "LuaLS test source must contain a cursor marker.");
  assert.equal(source.indexOf("|", marker + 1), -1, "LuaLS test source must contain one cursor marker.");
  const before = source.slice(0, marker);
  const lines = before.split("\n");
  return {
    text: source.slice(0, marker) + source.slice(marker + 1),
    position: { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 },
  };
}

class LuaLsSession {
  private readonly server = new LuaLanguageServerProcess();
  private readonly workspace = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-luals-packs-"));
  private readonly workspaceUri = pathToFileURL(this.workspace).href;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private requestId = 0;
  private documentId = 0;

  constructor(private readonly libraries: string[]) {}

  async start(): Promise<void> {
    const logPath = path.join(this.workspace, "logs");
    fs.mkdirSync(logPath);
    const settings = {
      runtime: {
        version: "Lua 5.4",
        nonstandardSymbol: ["`", "/**/", "+=", "-=", "*=", "/=", "<<=", ">>=", "&=", "|=", "^="],
        plugin: bundledPlugin,
      },
      completion: { callSnippet: "Disable", keywordSnippet: "Disable", showWord: "Disable", workspaceWord: false },
      diagnostics: { enable: false },
      workspace: { checkThirdParty: "Disable", library: this.libraries, maxPreload: 20_000, preloadFileSize: 2_000 },
    };
    this.server.start(
      bundledLuaLs,
      this.workspace,
      logPath,
      (message) => {
        if (typeof message.id === "number" && typeof message.method !== "string") {
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id);
          if (message.error && typeof message.error === "object") {
            waiter.reject(new Error(String((message.error as { message?: unknown }).message)));
          } else {
            waiter.resolve(message.result);
          }
          return;
        }
        if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
          const result = message.method === "workspace/configuration"
            ? Array.isArray((message.params as { items?: unknown[] } | undefined)?.items)
              ? (message.params as { items: unknown[] }).items.map(() => settings)
              : []
            : message.method === "workspace/workspaceFolders"
              ? [{ uri: this.workspaceUri, name: "test" }]
              : null;
          this.server.send({ jsonrpc: "2.0", id: message.id, result });
        }
      },
      (status) => {
        if (status.state !== "error") return;
        for (const waiter of this.pending.values()) waiter.reject(new Error(status.message ?? "LuaLS failed."));
        this.pending.clear();
      },
    );
    const initialized = await this.request("initialize", {
      processId: null,
      rootUri: this.workspaceUri,
      workspaceFolders: [{ uri: this.workspaceUri, name: "test" }],
      initializationOptions: { changeConfiguration: true },
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: {},
          completion: { completionItem: { snippetSupport: true, labelDetailsSupport: true } },
          signatureHelp: { signatureInformation: { parameterInformation: { labelOffsetSupport: true } } },
        },
      },
    });
    assert.ok(initialized && typeof initialized === "object" && "capabilities" in initialized);
    this.server.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    this.server.send({ jsonrpc: "2.0", method: "workspace/didChangeConfiguration", params: { settings: { Lua: settings } } });
  }

  async completions(source: string): Promise<CompletionItem[]> {
    const { text, position } = positionAtMarker(source);
    const uri = this.openDocument(text);
    return completionItems(await this.request("textDocument/completion", {
      textDocument: { uri },
      position,
      context: { triggerKind: 1 },
    }));
  }

  async waitForCompletion(source: string, symbol: string): Promise<CompletionItem[]> {
    let items: CompletionItem[] = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      items = await this.completions(source);
      if (completionHasSymbol(items, symbol)) return items;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Expected ${symbol} from libraries ${this.libraries.join(", ")}; received ${items.slice(0, 25).map(completionLabel).join(", ")}`);
  }

  async signatureLabels(source: string): Promise<string[]> {
    const { text, position } = positionAtMarker(source);
    const uri = this.openDocument(text);
    const result = await this.request("textDocument/signatureHelp", {
      textDocument: { uri },
      position,
      context: { triggerKind: 1, isRetrigger: false },
    });
    if (!result || typeof result !== "object" || !Array.isArray((result as { signatures?: unknown }).signatures)) return [];
    return (result as { signatures: unknown[] }).signatures.flatMap((signature) =>
      signature && typeof signature === "object" && typeof (signature as { label?: unknown }).label === "string"
        ? [(signature as { label: string }).label]
        : []);
  }

  async stop(): Promise<void> {
    await this.server.stop();
    fs.rmSync(this.workspace, { recursive: true, force: true });
  }

  private openDocument(text: string): string {
    const file = path.join(this.workspace, `completion-${++this.documentId}.lua`);
    fs.writeFileSync(file, text, "utf8");
    const uri = pathToFileURL(file).href;
    this.server.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "lua", version: 1, text } },
    });
    return uri;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    this.server.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

test("LuaLS library packs isolate FiveM/QBCore from RedM while retaining shared runtime", {
  skip: process.platform !== "win32" || !fs.existsSync(bundledLuaLs) || !fs.existsSync(bundledPlugin) || !packsReady,
  timeout: 45_000,
}, async () => {
  const fivem = new LuaLsSession([packRoots.fivem, packRoots.qbcore]);
  const redm = new LuaLsSession([packRoots.redm]);
  try {
    await fivem.start();
    await fivem.waitForCompletion("Citizen.Creat|", "CreateThread");
    await fivem.waitForCompletion("SetVehicleParachuteAct|", "SetVehicleParachuteActive");
    await fivem.waitForCompletion("CallMinimapScaleformFunct|", "CallMinimapScaleformFunction");
    await fivem.waitForCompletion("QBCore.Commands.A|", "Add");

    const fivemRedmGame = await fivem.completions("CreateAnimSc|");
    assert.equal(completionHasSymbol(fivemRedmGame, "CreateAnimScene"), false, "FiveM must not preload RedM game natives.");
    const fivemRedmPlatform = await fivem.completions("RegisterRawKeym|");
    assert.equal(completionHasSymbol(fivemRedmPlatform, "RegisterRawKeymap"), false, "FiveM must not preload RedM platform natives.");

    let signatureLabels: string[] = [];
    for (let attempt = 0; attempt < 30 && signatureLabels.length === 0; attempt += 1) {
      signatureLabels = await fivem.signatureLabels("CallMinimapScaleformFunction(|");
      if (signatureLabels.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      signatureLabels.some((label) =>
        label.includes("CallMinimapScaleformFunction") && label.includes("miniMap") && label.includes("fnName")
      ),
      `Expected a signature label with both native parameters, received: ${signatureLabels.join(", ")}`,
    );

    await redm.start();
    await redm.waitForCompletion("Citizen.Creat|", "CreateThread");
    await redm.waitForCompletion("CreateAnimSc|", "CreateAnimScene");
    await redm.waitForCompletion("RegisterRawKeym|", "RegisterRawKeymap");

    const redmFiveMGame = await redm.completions("SetVehicleParachuteAct|");
    assert.equal(completionHasSymbol(redmFiveMGame, "SetVehicleParachuteActive"), false, "RedM must not preload FiveM game natives.");
    const redmFiveMPlatform = await redm.completions("CallMinimapScaleformFunct|");
    assert.equal(completionHasSymbol(redmFiveMPlatform, "CallMinimapScaleformFunction"), false, "RedM must not preload FiveM platform natives.");
    const redmQbCore = await redm.completions("QBCore.Commands.A|");
    assert.equal(completionHasSymbol(redmQbCore, "Add"), false, "RedM must not preload QBCore globals.");
  } finally {
    await Promise.all([fivem.stop(), redm.stop()]);
  }
});
