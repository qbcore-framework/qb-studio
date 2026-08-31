import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { CfxTarget } from "./configStore";

const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const MAX_CACHED_LINES = 50_000;

interface CachedLine {
  text: string;
  bytes: number;
}

interface TailState {
  logFile: string;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
  offset: number;
  decoder: StringDecoder;
  lines: CachedLine[];
  lineBytes: number;
  partial: string;
}

export interface ClientConsoleReadOptions {
  target: CfxTarget;
  configuredExecutable: string | null;
  localAppData?: string | null;
  appData?: string | null;
  lines?: number;
}

export interface ClientConsoleSnapshot {
  available: boolean;
  output: string;
  target: CfxTarget;
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function addCandidate(output: string[], seen: Set<string>, candidate: string | null): void {
  if (!candidate || !path.isAbsolute(candidate)) return;
  const identity = pathIdentity(candidate);
  if (seen.has(identity)) return;
  seen.add(identity);
  output.push(candidate);
}

/** Returns small, fixed sets of log-directory candidates. Configured-install
 * locations take precedence over conventional per-user locations. */
export function clientLogDirectoryGroups(options: ClientConsoleReadOptions): string[][] {
  const configured: string[] = [];
  const conventional: string[] = [];
  const configuredSeen = new Set<string>();
  const conventionalSeen = new Set<string>();
  const executableDirectory = options.configuredExecutable && path.isAbsolute(options.configuredExecutable)
    ? path.dirname(options.configuredExecutable)
    : null;

  if (options.target === "enhanced") {
    addCandidate(configured, configuredSeen, executableDirectory ? path.join(executableDirectory, "logs") : null);
    addCandidate(conventional, conventionalSeen, options.appData ? path.join(options.appData, "FiveM for GTAV Enhanced", "logs") : null);
  } else {
    const product = options.target === "redm" ? "RedM" : "FiveM";
    const appFolder = `${product}.app`;
    addCandidate(configured, configuredSeen, executableDirectory ? path.join(executableDirectory, appFolder, "logs") : null);
    addCandidate(conventional, conventionalSeen, options.localAppData
      ? path.join(options.localAppData, product, appFolder, "logs")
      : null);
  }

  // The conventional candidate is often identical to the configured one.
  const configuredIdentities = new Set(configured.map(pathIdentity));
  return [configured, conventional.filter((candidate) => !configuredIdentities.has(pathIdentity(candidate)))]
    .filter((group) => group.length > 0);
}

function matchesClientLog(target: CfxTarget, name: string): boolean {
  if (target === "enhanced") return /^fivem-for-gtav-enhanced(?:(?:\.log)?[-_].*)?\.log$/i.test(name);
  return /^CitizenFX_log_[A-Za-z0-9T_.-]+\.log$/i.test(name);
}

function latestLogInDirectories(target: CfxTarget, directories: string[]): string | null {
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const directory of directories) {
    try {
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !matchesClientLog(target, entry.name)) continue;
        const file = path.join(directory, entry.name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        candidates.push({ file, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // A client that has never launched has no log directory yet. Other
      // inaccessible candidates should not prevent trying the fallback.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.file.localeCompare(left.file));
  return candidates[0]?.file ?? null;
}

export function findLatestClientLog(options: ClientConsoleReadOptions): string | null {
  for (const group of clientLogDirectoryGroups(options)) {
    const log = latestLogInDirectories(options.target, group);
    if (log) return log;
  }
  return null;
}

function readRange(logFile: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = fs.openSync(logFile, "r");
  let total = 0;
  try {
    while (total < length) {
      const read = fs.readSync(descriptor, buffer, total, length - total, start + total);
      if (read === 0) break;
      total += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return total === length ? buffer : buffer.subarray(0, total);
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function appendLine(state: TailState, value: string): void {
  if (!value) return;
  const text = utf8Tail(value, MAX_SCAN_BYTES);
  const bytes = Buffer.byteLength(text, "utf8") + 1;
  state.lines.push({ text, bytes });
  state.lineBytes += bytes;
  while (state.lineBytes > MAX_SCAN_BYTES || state.lines.length > MAX_CACHED_LINES) {
    const removed = state.lines.shift();
    if (!removed) break;
    state.lineBytes -= removed.bytes;
  }
}

function appendDecoded(state: TailState, decoded: string): void {
  const parts = `${state.partial}${decoded}`.split(/\r?\n/);
  state.partial = parts.pop() ?? "";
  for (const line of parts) appendLine(state, line);
  state.partial = utf8Tail(state.partial, MAX_SCAN_BYTES);
}

function buildTailState(logFile: string, stat: fs.Stats): TailState {
  const start = Math.max(0, stat.size - MAX_SCAN_BYTES);
  const bytes = readRange(logFile, start, stat.size - start);
  const decoder = new StringDecoder("utf8");
  let decoded = decoder.write(bytes);
  if (start > 0) {
    const firstNewline = decoded.indexOf("\n");
    decoded = firstNewline >= 0 ? decoded.slice(firstNewline + 1) : "";
  }
  const state: TailState = {
    logFile,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    mtimeMs: stat.mtimeMs,
    offset: start + bytes.length,
    decoder,
    lines: [],
    lineBytes: 0,
    partial: "",
  };
  appendDecoded(state, decoded);
  return state;
}

function refreshTailState(current: TailState | null, logFile: string, stat: fs.Stats): TailState {
  const sameFile = current?.logFile === logFile && current.ino === stat.ino && current.birthtimeMs === stat.birthtimeMs;
  const rewrittenWithoutGrowth = sameFile && stat.size === current!.offset && stat.mtimeMs !== current!.mtimeMs;
  if (!sameFile || stat.size < current!.offset || rewrittenWithoutGrowth || stat.size - current!.offset > MAX_SCAN_BYTES) {
    return buildTailState(logFile, stat);
  }
  if (stat.size > current!.offset) {
    const bytes = readRange(logFile, current!.offset, stat.size - current!.offset);
    current!.offset += bytes.length;
    appendDecoded(current!, current!.decoder.write(bytes));
  }
  current!.mtimeMs = stat.mtimeMs;
  return current!;
}

export class ClientConsoleReader {
  private readonly states = new Map<CfxTarget, TailState>();

  read(options: ClientConsoleReadOptions): ClientConsoleSnapshot {
    const logFile = findLatestClientLog(options);
    if (!logFile) {
      this.states.delete(options.target);
      return { available: false, output: "", target: options.target };
    }

    const state = refreshTailState(this.states.get(options.target) ?? null, logFile, fs.statSync(logFile));
    this.states.set(options.target, state);
    const lines = state.lines.map((line) => line.text);
    if (state.partial) lines.push(state.partial);
    const count = Math.max(1, Math.min(5000, options.lines ?? 200));
    let output = lines.slice(-count).join("\n");
    if (output.length > MAX_OUTPUT_CHARS) {
      output = `[output limited to the final ${MAX_OUTPUT_CHARS} characters]\n${output.slice(-MAX_OUTPUT_CHARS)}`;
    }
    return { available: true, output, target: options.target };
  }
}
