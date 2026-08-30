import fs from "node:fs";
import path from "node:path";

import { contains } from "./pathSafety";
import type { ConsoleSourceKind, ConsoleSourceLocationRequest } from "./consoleSourceParser";

export interface ResolvedConsoleSourceLocation {
  path: string;
  line: number;
  column: number;
}

interface OrdinaryDirectory {
  path: string;
  realPath: string;
}

interface ResourceIndexCacheEntry {
  globalGeneration: number;
  rootGeneration: number;
  promise: Promise<Map<string, string[]>>;
}

const MAX_INDEX_ENTRIES = 20_000;
const MAX_CATEGORY_DEPTH = 24;
const MAX_CACHED_ROOTS = 8;
const MAX_TRACKED_GENERATIONS = 32;
const MAX_SOURCE_LENGTH = 2_048;
const MAX_LINE = 10_000_000;
const MAX_COLUMN = 1_000_000;
const SOURCE_FILE = /\.(?:lua|js|mjs|cjs|ts|tsx|jsx|cs|cfg|json|sql|xml|html|css|scss|sass|vue|svelte)$/i;
const CATEGORY_FOLDER = /^\[[^\[\]\\/]+\]$/;

const resourceIndexes = new Map<string, ResourceIndexCacheEntry>();
const resourceIndexGenerations = new Map<string, number>();
let globalResourceIndexGeneration = 0;

function cacheKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Drop cached resource-name discovery after a workspace mutation or watcher event. */
export function invalidateConsoleSourceIndex(resourcesRoot?: string): void {
  if (resourcesRoot === undefined) {
    globalResourceIndexGeneration += 1;
    resourceIndexes.clear();
    resourceIndexGenerations.clear();
    return;
  }
  const key = cacheKey(resourcesRoot);
  resourceIndexGenerations.set(key, (resourceIndexGenerations.get(key) ?? 0) + 1);
  resourceIndexes.delete(key);
  while (resourceIndexGenerations.size > MAX_TRACKED_GENERATIONS) {
    const disposable = [...resourceIndexGenerations.keys()].find((candidate) =>
      candidate !== key && !resourceIndexes.has(candidate),
    );
    if (disposable === undefined) break;
    resourceIndexGenerations.delete(disposable);
  }
}

function finiteInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function sourceKind(value: unknown): ConsoleSourceKind {
  if (value !== "resource" && value !== "relative" && value !== "profile" && value !== "absolute") {
    throw new Error("Unsupported console source location kind.");
  }
  return value;
}

function hasNtfsAlternateDataStream(kind: ConsoleSourceKind, source: string): boolean {
  // The one colon in an ordinary drive-absolute path is syntax, not an ADS.
  // Every colon in a relative path, and any later colon in an absolute path,
  // can select an NTFS alternate data stream and must be refused on all hosts.
  const withoutDrive = kind === "absolute" && /^[A-Za-z]:[\\/]/.test(source) ? source.slice(2) : source;
  return withoutDrive.includes(":");
}

function sourceRequest(value: unknown): ConsoleSourceLocationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Console source location must be an object.");
  const candidate = value as Record<string, unknown>;
  const kind = sourceKind(candidate.kind);
  if (typeof candidate.source !== "string" || candidate.source !== candidate.source.trim() ||
      candidate.source.length < 1 || candidate.source.length > MAX_SOURCE_LENGTH ||
      /[\u0000-\u001f]/.test(candidate.source) || !SOURCE_FILE.test(candidate.source)) {
    throw new Error("Console source path is invalid.");
  }
  if (hasNtfsAlternateDataStream(kind, candidate.source)) {
    throw new Error("Console source paths cannot address an NTFS alternate data stream.");
  }
  let resourceName: string | undefined;
  if (candidate.resourceName !== undefined) {
    if (typeof candidate.resourceName !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(candidate.resourceName)) {
      throw new Error("Console resource name is invalid.");
    }
    resourceName = candidate.resourceName;
  }
  if ((kind === "resource" || kind === "relative") && !resourceName) {
    throw new Error("Console source location is missing its resource name.");
  }
  return {
    kind,
    source: candidate.source,
    ...(resourceName ? { resourceName } : {}),
    line: finiteInteger(candidate.line, "Console source line", MAX_LINE),
    column: finiteInteger(candidate.column, "Console source column", MAX_COLUMN),
  };
}

async function ordinaryDirectory(value: string, label: string): Promise<OrdinaryDirectory> {
  const resolved = path.resolve(value);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} no longer exists.`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be an ordinary directory.`);
  return { path: resolved, realPath: await fs.promises.realpath(resolved) };
}

async function ordinaryContainedDirectory(
  root: OrdinaryDirectory,
  candidate: string,
  label: string,
  missingAllowed = false,
): Promise<OrdinaryDirectory | null> {
  if (!contains(root.path, candidate)) throw new Error(`${label} is outside the selected workspace.`);
  let current = root.path;
  for (const part of path.relative(root.path, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (missingAllowed) return null;
        throw new Error(`${label} no longer exists.`);
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link, junction, or non-directory component.`);
    }
  }
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingAllowed) return null;
    throw error;
  }
  if (!contains(root.realPath, realPath)) throw new Error(`${label} resolves outside the selected workspace.`);
  return { path: candidate, realPath };
}

async function ordinaryChildDirectory(root: OrdinaryDirectory, parent: string, name: string): Promise<string | null> {
  const child = path.join(parent, name);
  const ordinary = await ordinaryContainedDirectory(root, child, "Resource discovery path", true);
  return ordinary?.path ?? null;
}

async function buildResourceIndex(resourcesRoot: OrdinaryDirectory): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const pending: Array<{ directory: string; depth: number }> = [{ directory: resourcesRoot.path, depth: 0 }];
  let visitedEntries = 0;

  for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
    const current = pending[pendingIndex];
    if (!await ordinaryContainedDirectory(resourcesRoot, current.directory, "Resource category", true)) continue;
    let directory: fs.Dir;
    try {
      directory = await fs.promises.opendir(current.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for await (const entry of directory) {
      if (++visitedEntries > MAX_INDEX_ENTRIES) {
        throw new Error(`Resource lookup exceeded ${MAX_INDEX_ENTRIES} workspace entries.`);
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const child = await ordinaryChildDirectory(resourcesRoot, current.directory, entry.name);
      if (!child) continue;
      if (CATEGORY_FOLDER.test(entry.name)) {
        if (current.depth >= MAX_CATEGORY_DEPTH) {
          throw new Error(`Resource lookup exceeded ${MAX_CATEGORY_DEPTH} nested category folders.`);
        }
        pending.push({ directory: child, depth: current.depth + 1 });
        continue;
      }

      // This is the resource boundary used by Cfx discovery: only bracketed
      // category folders recurse. An ordinary directory claims its name even
      // if its manifest is missing or malformed, so never scan below it.
      const key = entry.name.toLowerCase();
      const matches = index.get(key);
      if (matches) matches.push(child);
      else index.set(key, [child]);
    }
  }
  return index;
}

function touchCacheEntry(key: string, entry: ResourceIndexCacheEntry): void {
  resourceIndexes.delete(key);
  resourceIndexes.set(key, entry);
}

async function resourceIndex(resourcesRoot: OrdinaryDirectory): Promise<Map<string, string[]>> {
  const key = cacheKey(resourcesRoot.realPath);
  for (;;) {
    const rootGeneration = resourceIndexGenerations.get(key) ?? 0;
    const globalGeneration = globalResourceIndexGeneration;
    let entry = resourceIndexes.get(key);
    if (!entry || entry.rootGeneration !== rootGeneration || entry.globalGeneration !== globalGeneration) {
      entry = { globalGeneration, rootGeneration, promise: buildResourceIndex(resourcesRoot) };
      resourceIndexes.set(key, entry);
      while (resourceIndexes.size > MAX_CACHED_ROOTS) {
        const oldest = resourceIndexes.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        resourceIndexes.delete(oldest);
      }
      void entry.promise.catch(() => {
        if (resourceIndexes.get(key) === entry) resourceIndexes.delete(key);
      });
    } else {
      touchCacheEntry(key, entry);
    }
    const result = await entry.promise;
    // LRU eviction does not make an already-built index stale. A generation
    // change does, including when invalidation raced an in-flight scan.
    if (globalResourceIndexGeneration === entry.globalGeneration &&
        (resourceIndexGenerations.get(key) ?? 0) === entry.rootGeneration) return result;
  }
}

async function findResourceRoot(resourcesRoot: OrdinaryDirectory, resourceName: string): Promise<string> {
  const matches = (await resourceIndex(resourcesRoot)).get(resourceName.toLowerCase()) ?? [];
  if (matches.length === 0) throw new Error(`Resource "${resourceName}" was not found in the selected workspace.`);
  if (matches.length > 1) throw new Error(`Resource "${resourceName}" is ambiguous in the selected workspace.`);
  return matches[0];
}

function pathSegments(value: string): string[] {
  return value.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
}

function resourceRelativePath(request: ConsoleSourceLocationRequest): string {
  if (path.win32.isAbsolute(request.source) || path.posix.isAbsolute(request.source)) {
    throw new Error("A resource console location cannot use an absolute path.");
  }
  const segments = pathSegments(request.source);
  if (request.kind === "relative") {
    while (segments[0] === "." || segments[0] === "..") segments.shift();
    if (segments[0]?.toLowerCase() === request.resourceName!.toLowerCase() && segments.length > 1) segments.shift();
  }
  if (segments.length === 0 || segments.some((part) => part === "." || part === "..")) {
    throw new Error("Console source path attempts to leave its resource.");
  }
  return segments.join(path.sep);
}

async function ordinarySourceFile(root: OrdinaryDirectory, relative: string): Promise<string> {
  const candidate = path.resolve(root.path, relative || ".");
  if (!contains(root.path, candidate)) throw new Error(`Path "${relative}" is outside the project folder — refused.`);

  const parts = path.relative(root.path, candidate).split(path.sep).filter(Boolean);
  let current = root.path;
  let stat: fs.Stats = await fs.promises.lstat(root.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Console source root must be an ordinary directory.");
  }
  for (const part of parts) {
    current = path.join(current, part);
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new Error("That console source file no longer exists.");
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Path "${relative}" contains a symbolic link or junction — refused.`);
  }
  if (!stat.isFile()) throw new Error("That console source location is not an ordinary file.");
  const realCandidate = await fs.promises.realpath(candidate);
  if (!contains(root.realPath, realCandidate)) throw new Error(`Path "${relative}" resolves outside the project folder — refused.`);
  return realCandidate;
}

/** Resolve an untrusted renderer request without blocking Electron's main thread. */
export async function resolveConsoleSourceLocation(
  profileRootValue: string,
  resourcesRootValue: string,
  value: unknown,
): Promise<ResolvedConsoleSourceLocation> {
  const request = sourceRequest(value);
  const [profileRoot, resourcesRoot] = await Promise.all([
    ordinaryDirectory(profileRootValue, "Profile root"),
    ordinaryDirectory(resourcesRootValue, "Resources root"),
  ]);
  if (!contains(profileRoot.path, resourcesRoot.path) || !contains(profileRoot.realPath, resourcesRoot.realPath)) {
    throw new Error("Resources root is outside the selected profile.");
  }

  let sourcePath: string;
  if (request.kind === "absolute") {
    if (!path.win32.isAbsolute(request.source) && !path.posix.isAbsolute(request.source)) {
      throw new Error("Absolute console source path is invalid.");
    }
    sourcePath = await ordinarySourceFile(profileRoot, path.relative(profileRoot.path, path.normalize(request.source)));
  } else if (request.kind === "profile") {
    if (path.win32.isAbsolute(request.source) || path.posix.isAbsolute(request.source)) {
      throw new Error("Profile console source path must be relative.");
    }
    sourcePath = await ordinarySourceFile(profileRoot, request.source.replace(/[\\/]/g, path.sep));
  } else {
    const resourceRootPath = await findResourceRoot(resourcesRoot, request.resourceName!);
    const resourceRoot = await ordinaryContainedDirectory(resourcesRoot, resourceRootPath, "Resource root");
    if (!resourceRoot) throw new Error("Resource root no longer exists.");
    sourcePath = await ordinarySourceFile(resourceRoot, resourceRelativePath(request));
  }

  return { path: sourcePath, line: request.line, column: request.column };
}
