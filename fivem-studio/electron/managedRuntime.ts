import { app } from "electron";
import { isUtf8 } from "node:buffer";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { StudioConfig } from "./configStore";
import { contentRevision, writeTextFile } from "./fsTree";
import { isLoopbackHostname } from "./localUrl";
import { assertSafeBasename, resolveInsideRoot } from "./pathSafety";
import { ensureRemoteRuntime, stopRemoteRuntime } from "./remoteRuntime";

export interface LocalServerConfig {
  host: string;
  port: number;
  rconPassword: string;
}

export interface ManagedRuntimeConnection {
  url: string;
  token: string;
  serverIdentity: {
    workspacePath: string;
    serverConfigPath: string;
    rcon: { host: string; port: number };
  };
}

const MAX_TXADMIN_CONFIG_BYTES = 1024 * 1024;

interface ReadyMessage {
  type: "ready";
  port: number;
  protocolVersion: number;
}

let child: ChildProcess | null = null;
let connection: ManagedRuntimeConnection | null = null;
let activeWorkspaceKey: string | null = null;
let starting: Promise<ManagedRuntimeConnection> | null = null;

/** A stale launch may report an error after a newer workspace has started. */
export class ManagedRuntimeGeneration {
  private value = 0;

  start(): number {
    this.value += 1;
    return this.value;
  }

  invalidate(): void {
    this.value += 1;
  }

  owns(generation: number): boolean {
    return generation === this.value;
  }
}

const runtimeGeneration = new ManagedRuntimeGeneration();

const MAX_CONFIG_INCLUDE_DEPTH = 8;
const MAX_CONFIG_FILES = 32;
const MAX_CONFIG_FILE_BYTES = 128 * 1024;
const MAX_CONFIG_TOTAL_BYTES = 512 * 1024;

function parseConfigValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("FXServer configuration value must not be empty.");
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    if (end < 0) throw new Error("FXServer configuration has an unterminated quoted value.");
    const remainder = trimmed.slice(end + 1).trim();
    if (remainder && !remainder.startsWith("#")) {
      throw new Error("FXServer configuration has unexpected text after a quoted value.");
    }
    return trimmed.slice(1, end);
  }
  return trimmed.split(/\s+#/, 1)[0].trim();
}

function parseEndpoint(value: string): { host: string; port: number } {
  const ipv6 = value.match(/^\[([^\]]+)]:(\d{1,5})$/);
  const ipv4 = value.match(/^([^:]+):(\d{1,5})$/);
  const configuredHost = ipv6?.[1] ?? ipv4?.[1];
  const rawPort = ipv6?.[2] ?? ipv4?.[2];
  const port = Number(rawPort);
  if (!configuredHost || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid local FXServer endpoint: ${value}`);
  }

  // Cfx.re and txAdmin generate wildcard bind addresses by default. A bind
  // address is not a remote destination: mirror txAdmin's own connection
  // behavior and turn it into an explicit loopback RCON target. Specific LAN,
  // public, and hostname targets remain forbidden.
  const normalizedHost = configuredHost.toLowerCase();
  const host = normalizedHost === "0.0.0.0" ? "127.0.0.1" : normalizedHost === "::" ? "::1" : configuredHost;
  if (!isLoopbackHostname(host)) {
    throw new Error(
      `The selected server.cfg binds FXServer to ${configuredHost}. QB Studio only accepts numeric loopback endpoints or the standard 0.0.0.0/[::] wildcard binds.`,
    );
  }
  return { host, port };
}

/** Parse only the two values the private coding runtime needs. No config
 * content or credentials are ever returned to the renderer. */
export function parseLocalServerConfig(contents: string): LocalServerConfig {
  const endpoints: Array<{ kind: "tcp" | "udp"; host: string; port: number }> = [];
  let rconPassword = "";

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const endpoint = line.match(/^endpoint_add_(tcp|udp)\s+(.+)$/i);
    if (endpoint) {
      endpoints.push({ kind: endpoint[1].toLowerCase() as "tcp" | "udp", ...parseEndpoint(parseConfigValue(endpoint[2])) });
      continue;
    }
    if (/^setr\s+rcon_password\b/i.test(line)) {
      throw new Error("`setr rcon_password` would replicate the password to clients. Use `set rcon_password` instead.");
    }
    // Both forms are accepted by FXServer. The official starter server.cfg
    // uses `set rcon_password`, while older/local configs often omit `set`.
    const rcon = line.match(/^(?:set\s+)?rcon_password\s+(.+)$/i);
    if (rcon) rconPassword = parseConfigValue(rcon[1]);
  }

  if (endpoints.length === 0) {
    throw new Error("The selected server.cfg has no endpoint_add_tcp/udp directive.");
  }
  const chosen = endpoints.find((endpoint) => endpoint.kind === "udp") ?? endpoints[0];
  return { host: chosen.host, port: chosen.port, rconPassword };
}

/**
 * Resolve every FXServer `exec` input before extracting endpoints. Includes are
 * bounded, cannot traverse outside the selected workspace, and retain their
 * position so a later rcon_password override has normal FXServer semantics.
 */
export function loadLocalServerConfig(profileRoot: string): string {
  let includedFiles = 0;
  let totalBytes = 0;
  const activePaths = new Set<string>();

  const load = (relativePath: string, depth: number): string => {
    if (depth > MAX_CONFIG_INCLUDE_DEPTH) {
      throw new Error(`FXServer config include depth exceeds ${MAX_CONFIG_INCLUDE_DEPTH}.`);
    }
    if (++includedFiles > MAX_CONFIG_FILES) {
      throw new Error(`FXServer config includes exceed ${MAX_CONFIG_FILES} files.`);
    }

    const configPath = resolveInsideRoot(profileRoot, relativePath);
    const normalizedPath = process.platform === "win32" ? configPath.toLowerCase() : configPath;
    if (activePaths.has(normalizedPath)) {
      throw new Error(`FXServer config include cycle detected at "${relativePath}".`);
    }
    const stat = fs.statSync(configPath);
    if (!stat.isFile()) throw new Error(`FXServer config "${relativePath}" must be a file.`);
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
      throw new Error(`FXServer config "${relativePath}" exceeds ${MAX_CONFIG_FILE_BYTES} bytes.`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_CONFIG_TOTAL_BYTES) {
      throw new Error(`FXServer config includes exceed ${MAX_CONFIG_TOTAL_BYTES} bytes in total.`);
    }

    activePaths.add(normalizedPath);
    try {
      const output: string[] = [];
      for (const rawLine of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
          output.push(rawLine);
          continue;
        }
        const exec = line.match(/^exec\s+(.+)$/i);
        if (!exec) {
          output.push(rawLine);
          continue;
        }
        const target = parseConfigValue(exec[1]);
        if (!target) throw new Error("FXServer config exec target must not be empty.");
        output.push(load(target, depth + 1));
      }
      return output.join("\n");
    } finally {
      activePaths.delete(normalizedPath);
    }
  };

  return load("server.cfg", 0);
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface TxAdminControlProfileSnapshot {
  configPath: string;
  profilePath: string;
  raw: Buffer;
  parsed: Record<string, unknown>;
  server: Record<string, unknown>;
  dataPath: string;
}

export interface TxAdminDataPathSyncResult {
  controlProfile: "default";
  configPath: string;
  dataPath: string;
  updated: boolean;
}

function txAdminControlProfileSnapshot(txDataPath: string, controlProfile: string): TxAdminControlProfileSnapshot {
  const profile = assertSafeBasename(controlProfile);
  const profilePath = resolveInsideRoot(txDataPath, profile);
  let profileStat: fs.Stats;
  try {
    profileStat = fs.lstatSync(profilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `txAdmin's ${profile} control profile is missing. Set up txAdmin in this txData folder before starting the server.`,
      );
    }
    throw error;
  }
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    throw new Error(`txAdmin's ${profile} control profile must be a real directory.`);
  }

  const configPath = resolveInsideRoot(profilePath, "config.json");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`txAdmin's ${profile}/config.json is missing. Finish the txAdmin setup before starting the server.`);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`txAdmin's ${profile}/config.json must be a regular file.`);
  }
  if (stat.size > MAX_TXADMIN_CONFIG_BYTES) {
    throw new Error(`txAdmin's ${profile}/config.json is too large to update safely.`);
  }

  const raw = fs.readFileSync(configPath);
  if (raw.length !== stat.size) {
    throw new Error(`txAdmin's ${profile}/config.json changed while QB Studio was reading it. Try starting again.`);
  }
  if (!isUtf8(raw)) throw new Error(`txAdmin's ${profile}/config.json is not valid UTF-8.`);

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`txAdmin's ${profile}/config.json is not valid JSON. Repair it in txAdmin before starting the server.`);
  }
  if (typeof parsedValue !== "object" || parsedValue === null || Array.isArray(parsedValue)) {
    throw new Error(`txAdmin's ${profile}/config.json must contain a JSON object.`);
  }
  const parsed = parsedValue as Record<string, unknown>;
  if (typeof parsed.server !== "object" || parsed.server === null || Array.isArray(parsed.server)) {
    throw new Error(`txAdmin's ${profile}/config.json has no valid server configuration.`);
  }
  const server = parsed.server as Record<string, unknown>;
  if (typeof server.dataPath !== "string" || !server.dataPath.trim()) {
    throw new Error(`txAdmin's ${profile}/config.json has no valid server.dataPath.`);
  }
  return { configPath, profilePath, raw, parsed, server, dataPath: server.dataPath };
}

function resolvedTxAdminDataPath(snapshot: TxAdminControlProfileSnapshot): string {
  return path.isAbsolute(snapshot.dataPath)
    ? snapshot.dataPath
    : path.resolve(snapshot.profilePath, snapshot.dataPath);
}

function txAdminDataPathValue(workspacePath: string): string {
  const resolved = path.resolve(workspacePath).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? `${resolved.replace(/\\/g, "/")}/` : `${resolved}${path.sep}`;
}

function serializeTxAdminConfig(snapshot: TxAdminControlProfileSnapshot): string {
  const source = snapshot.raw.toString("utf8");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = source.match(/\r?\n([ \t]+)"/);
  const indent = indentMatch?.[1] ?? (source.includes("\n") ? "  " : undefined);
  const trailingNewline = /\r?\n$/.test(source) ? newline : "";
  return `${JSON.stringify(snapshot.parsed, null, indent).replace(/\n/g, newline)}${trailingNewline}`;
}

/**
 * Enhanced artifacts always boot txAdmin's default control profile. Keep that
 * profile pointed at the selected Studio workspace, then re-read it so a
 * failed, stale, or concurrent update can never silently launch another one.
 */
export function synchronizeTxAdminDataPath(txDataPath: string, workspacePath: string): TxAdminDataPathSyncResult {
  const workspace = resolveInsideRoot(txDataPath, path.relative(txDataPath, workspacePath));
  const workspaceStat = fs.lstatSync(workspace);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("The selected txAdmin server-data workspace must be a real directory.");
  }

  const target = normalizedPath(workspace);
  const snapshot = txAdminControlProfileSnapshot(txDataPath, "default");
  if (normalizedPath(resolvedTxAdminDataPath(snapshot)) === target) {
    return { controlProfile: "default", configPath: snapshot.configPath, dataPath: snapshot.dataPath, updated: false };
  }

  snapshot.server.dataPath = txAdminDataPathValue(workspace);
  writeTextFile(snapshot.configPath, serializeTxAdminConfig(snapshot), contentRevision(snapshot.raw));
  const verified = assertTxAdminDataPath(txDataPath, workspace, "default");
  return { controlProfile: "default", configPath: verified.configPath, dataPath: verified.dataPath, updated: true };
}

/** Refuse startup unless the selected control profile still resolves to the selected workspace. */
export function assertTxAdminDataPath(
  txDataPath: string,
  workspacePath: string,
  controlProfile = "default",
): Pick<TxAdminDataPathSyncResult, "configPath" | "dataPath"> {
  const workspace = resolveInsideRoot(txDataPath, path.relative(txDataPath, workspacePath));
  const snapshot = txAdminControlProfileSnapshot(txDataPath, controlProfile);
  if (normalizedPath(resolvedTxAdminDataPath(snapshot)) !== normalizedPath(workspace)) {
    throw new Error(
      `txAdmin's ${controlProfile}/config.json points at a different server-data workspace. The server was not started.`,
    );
  }
  return { configPath: snapshot.configPath, dataPath: snapshot.dataPath };
}

/**
 * txAdmin's control profile (`txData/<name>/config.json`) and the editable
 * server-data workspace (`txData/<recipe>.base`) are different domains. Find
 * the control profile only when its `server.dataPath` unambiguously references
 * the selected workspace; otherwise console tailing remains disabled.
 */
export function discoverTxAdminControlProfile(txDataPath: string, workspacePath: string): string | null {
  const target = normalizedPath(workspacePath);
  const matches: string[] = [];

  for (const entry of fs.readdirSync(txDataPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let profile: string;
    try {
      profile = assertSafeBasename(entry.name);
    } catch {
      continue;
    }

    const profilePath = resolveInsideRoot(txDataPath, profile);
    const configPath = resolveInsideRoot(profilePath, "config.json");
    try {
      const stat = fs.lstatSync(configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TXADMIN_CONFIG_BYTES) continue;
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const server = (parsed as { server?: unknown }).server;
      if (typeof server !== "object" || server === null || Array.isArray(server)) continue;
      const dataPath = (server as { dataPath?: unknown }).dataPath;
      if (typeof dataPath !== "string" || !dataPath.trim()) continue;
      const referenced = path.isAbsolute(dataPath) ? dataPath : path.resolve(profilePath, dataPath);
      if (normalizedPath(referenced) === target) matches.push(profile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A malformed or inaccessible control profile must never be trusted as
        // the console source. It does not prevent file editing/RCON capability.
      }
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

function runtimeScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "runtime", "runtime.cjs")
    : path.resolve(__dirname, "..", "..", "fivem-mcp-server", "bundle", "runtime.cjs");
}

function systemEnvironment(): NodeJS.ProcessEnv {
  const names = ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"];
  return Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))) as NodeJS.ProcessEnv;
}

export async function ensureManagedRuntime(config: StudioConfig): Promise<ManagedRuntimeConnection> {
  // Opt-in remote host. With config.remote unset this is skipped entirely and
  // the local path below runs unchanged.
  if (config.remote) {
    stopManagedRuntime();
    return ensureRemoteRuntime(config.remote, runtimeScriptPath());
  }
  stopRemoteRuntime();
  if (!config.txDataPath || !config.selectedProfile) {
    throw new Error("Choose a local txData workspace in Settings before connecting the coding runtime.");
  }
  const profile = assertSafeBasename(config.selectedProfile);
  const profileRoot = resolveInsideRoot(config.txDataPath, profile);
  const serverCfgPath = resolveInsideRoot(profileRoot, "server.cfg");
  const serverConfigContents = loadLocalServerConfig(profileRoot);
  const localServer = parseLocalServerConfig(serverConfigContents);
  const txAdminControlProfile = discoverTxAdminControlProfile(config.txDataPath, profileRoot);
  const workspaceKey = `${path.resolve(profileRoot)}\0${txAdminControlProfile ?? ""}\0${localServer.host}\0${localServer.port}\0${localServer.rconPassword}`;

  if (connection && child && !child.killed && activeWorkspaceKey === workspaceKey) return connection;
  if (starting && activeWorkspaceKey === workspaceKey) return starting;
  stopManagedRuntime();
  activeWorkspaceKey = workspaceKey;

  const scriptPath = runtimeScriptPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error("The bundled coding runtime is missing. Reinstall QB Studio or run the runtime bundle build.");
  }

  const token = randomBytes(32).toString("base64url");
  const launchGeneration = runtimeGeneration.start();
  const startup = new Promise<ManagedRuntimeConnection>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const spawned = spawn(process.execPath, [scriptPath], {
      cwd: app.getPath("userData"),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...systemEnvironment(),
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        MCP_TRANSPORT: "http",
        MCP_HOST: "127.0.0.1",
        MCP_PORT: "0",
        MCP_TOKEN: token,
        RCON_HOST: localServer.host,
        RCON_PORT: String(localServer.port),
        RCON_PASSWORD: localServer.rconPassword,
        SERVER_DATA_WORKSPACE: path.resolve(profileRoot),
        SERVER_CONFIG_PATH: path.resolve(serverCfgPath),
        TXADMIN_DATA_DIR: txAdminControlProfile ? path.resolve(config.txDataPath!) : "",
        TXADMIN_CONTROL_PROFILE: txAdminControlProfile ?? "",
      },
    });
    child = spawned;
    const ownsRuntime = () => runtimeGeneration.owns(launchGeneration) && child === spawned;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ownsRuntime()) {
        child = null;
        connection = null;
        activeWorkspaceKey = null;
      }
      if (!spawned.killed) spawned.kill();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("The bundled coding runtime did not become ready within 10 seconds."), 10_000);
    timer.unref();

    spawned.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    spawned.on("error", (error) => fail(`Could not start the bundled coding runtime: ${error.message}`));
    spawned.on("exit", (code) => {
      if (!settled) fail(`The bundled coding runtime exited with code ${code ?? "unknown"}.${stderr ? ` ${stderr.trim()}` : ""}`);
      else if (ownsRuntime()) {
        child = null;
        connection = null;
        activeWorkspaceKey = null;
      }
    });
    spawned.on("message", (message: unknown) => {
      const ready = message as Partial<ReadyMessage>;
      if (
        settled ||
        !ownsRuntime() ||
        ready?.type !== "ready" ||
        ready.protocolVersion !== 1 ||
        !Number.isInteger(ready.port) ||
        (ready.port as number) < 1 ||
        (ready.port as number) > 65535
      ) return;
      clearTimeout(timer);
      settled = true;
      connection = {
        url: `http://127.0.0.1:${ready.port}/mcp`,
        token,
        serverIdentity: {
          workspacePath: path.resolve(profileRoot),
          serverConfigPath: path.resolve(serverCfgPath),
          rcon: { host: localServer.host, port: localServer.port },
        },
      };
      resolve(connection);
    });
  });
  const trackedStartup = startup.finally(() => {
    if (starting === trackedStartup) starting = null;
  });
  starting = trackedStartup;
  return trackedStartup;
}

export function stopEveryRuntime(): void {
  stopRemoteRuntime();
  stopManagedRuntime();
}

export function stopManagedRuntime(): void {
  runtimeGeneration.invalidate();
  const stopping = child;
  child = null;
  connection = null;
  activeWorkspaceKey = null;
  if (stopping && !stopping.killed) stopping.kill();
}
