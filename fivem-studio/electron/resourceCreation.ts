import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createTextFile } from "./fsTree";
import { assertSafeBasename, contains, resolveInsideRoot } from "./pathSafety";
import { resolveResourceContext, resourceManifestPath } from "./resourceContext";
import { requireStarterResourceTemplate, starterResourceFiles, type StarterResourceTemplate } from "./resourceTemplates";

const MAX_RESOURCE_ENTRIES = 20_000;
const MAX_CATEGORY_DEPTH = 24;

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
  template: StarterResourceTemplate;
}

function ordinaryResourcesRoot(value: string): string {
  const requestedRoot = path.resolve(value);
  const requestedStat = fs.lstatSync(requestedRoot);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error("Resources root must be an ordinary directory.");
  }
  const root = resolveInsideRoot(requestedRoot, ".");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Resources root must be an ordinary directory.");
  return root;
}

function creationParent(resourcesRoot: string, parentValue: string): string {
  const parent = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, parentValue));
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Choose an ordinary folder inside Resources.");
  return parent;
}

function entryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validatedEntryName(nameValue: string): string {
  const name = assertSafeBasename(nameValue);
  const lowerName = name.toLowerCase();
  if ([".git", ".ds_store", "node_modules"].includes(lowerName) || lowerName.startsWith(".qb-studio-")) {
    throw new Error(`"${name}" is reserved and cannot be created from the Resources tree.`);
  }
  return name;
}

function creationTarget(resourcesRoot: string, parentValue: string, nameValue: string): { parent: string; name: string; target: string } {
  const name = validatedEntryName(nameValue);
  const parent = creationParent(resourcesRoot, parentValue);
  const target = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, path.join(parent, name)));
  if (entryExists(target)) throw new Error(`"${name}" already exists in that folder.`);
  return { parent, name, target };
}

/** Create one empty editor-safe text file without overwriting an existing entry. */
export function createResourceFile(resourcesRootValue: string, parentValue: string, nameValue: string): CreatedResourceEntry {
  const resourcesRoot = ordinaryResourcesRoot(resourcesRootValue);
  const { name, target } = creationTarget(resourcesRoot, parentValue, nameValue);
  try {
    createTextFile(target, "");
  } catch (error) {
    if (entryExists(target)) throw new Error(`"${name}" already exists in that folder.`);
    throw error;
  }
  return { name, path: target, isDirectory: false };
}

/** Create one folder without recursive or overwrite semantics. */
export function createResourceDirectory(resourcesRootValue: string, parentValue: string, nameValue: string): CreatedResourceEntry {
  const resourcesRoot = ordinaryResourcesRoot(resourcesRootValue);
  const { name, target } = creationTarget(resourcesRoot, parentValue, nameValue);
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`"${name}" already exists in that folder.`);
    throw error;
  }
  return { name, path: target, isDirectory: true };
}

function removeOwnedStaging(parent: string, staging: string): void {
  const resolvedParent = path.resolve(parent);
  const resolvedStaging = path.resolve(staging);
  if (!contains(resolvedParent, resolvedStaging) || path.dirname(resolvedStaging) !== resolvedParent ||
      !path.basename(resolvedStaging).startsWith(".qb-studio-template-")) {
    throw new Error("Refusing to clean an unverified starter-resource staging directory.");
  }
  fs.rmSync(resolvedStaging, { recursive: true, force: true });
}

function isCategoryFolder(name: string): boolean {
  return /^\[[^\[\]\\/]+\]$/.test(name);
}

function assertStarterParent(resourcesRoot: string, parent: string): void {
  const relative = path.relative(resourcesRoot, parent);
  if (!relative) return;
  if (relative.split(path.sep).every(isCategoryFolder)) return;
  if (resolveResourceContext(resourcesRoot, parent)) {
    throw new Error("Create a starter resource in Resources or a category folder, not inside another resource.");
  }
  throw new Error("Starter resources can be created only in Resources or bracketed category folders such as [local].");
}

function workspaceHasResourceName(resourcesRoot: string, name: string): boolean {
  const sought = name.toLowerCase();
  const pending: Array<{ directory: string; depth: number }> = [{ directory: resourcesRoot, depth: 0 }];
  let visited = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current.depth > MAX_CATEGORY_DEPTH) {
      throw new Error(`Resource-name lookup exceeded ${MAX_CATEGORY_DEPTH} nested category folders.`);
    }
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      if (++visited > MAX_RESOURCE_ENTRIES) {
        throw new Error(`Resource-name lookup exceeded ${MAX_RESOURCE_ENTRIES} workspace entries.`);
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
      const lower = entry.name.toLowerCase();
      if (isCategoryFolder(entry.name)) {
        const child = resolveInsideRoot(resourcesRoot, path.relative(resourcesRoot, path.join(current.directory, entry.name)));
        pending.push({ directory: child, depth: current.depth + 1 });
      } else if (!entry.name.startsWith(".") && lower !== "txadmin" && lower !== "yarn" && lower !== "webpack" && lower === sought) {
        // Cfx claims every ordinary non-category directory as a resource name,
        // even before it learns whether that directory has a usable manifest.
        return true;
      }
    }
  }
  return false;
}

function stagingFileNames(staging: string): string[] {
  const files: string[] = [];
  const pending: Array<{ directory: string; relative: string }> = [{ directory: staging, relative: "" }];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Starter-resource staging contains a symbolic link or junction.");
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) pending.push({ directory: absolute, relative });
      else if (entry.isFile()) files.push(relative);
      else throw new Error("Starter-resource staging contains an unsupported filesystem entry.");
    }
  }
  return files.sort();
}

function verifyStarterStaging(staging: string, expectedNames: string[]): void {
  const expected = [...expectedNames].sort();
  const actual = stagingFileNames(staging);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]) || !resourceManifestPath(staging)) {
    throw new Error("Starter-resource staging validation failed before publication.");
  }
}

/** Atomically publish a small, current Cfx starter resource in a category folder or Resources root. */
export function createStarterResource(
  resourcesRootValue: string,
  parentValue: string,
  nameValue: string,
  game: "gta5" | "rdr3" = "gta5",
  templateValue: StarterResourceTemplate = "lua",
  templateCatalogRoot = "",
): StarterResourceResult {
  const resourcesRoot = ordinaryResourcesRoot(resourcesRootValue);
  const name = validatedEntryName(nameValue);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new Error("Resource names must start with a letter or number and use only letters, numbers, dots, underscores, or hyphens.");
  }
  if (["txadmin", "yarn", "webpack"].includes(name.toLowerCase())) {
    throw new Error(`"${name}" is reserved by the Cfx resource scanner and cannot be used for a starter resource.`);
  }
  const template = requireStarterResourceTemplate(templateValue);
  const { parent, target } = creationTarget(resourcesRoot, parentValue, name);
  assertStarterParent(resourcesRoot, parent);
  if (workspaceHasResourceName(resourcesRoot, name)) {
    throw new Error(`A resource named "${name}" already exists elsewhere in this workspace.`);
  }

  const staging = resolveInsideRoot(resourcesRoot, path.relative(
    resourcesRoot,
    path.join(parent, `.qb-studio-template-${randomUUID()}`),
  ));
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const files = starterResourceFiles(templateCatalogRoot, template, game, name);
    const result: StarterResourceResult = {
      name,
      rootPath: target,
      manifestPath: path.join(target, "fxmanifest.lua"),
      files: Object.keys(files),
      fileCount: Object.keys(files).length,
      game,
      template,
    };
    for (const [filename, content] of Object.entries(files)) {
      const targetFile = resolveInsideRoot(staging, filename.replace(/\//g, path.sep));
      fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 });
      createTextFile(targetFile, content);
    }
    verifyStarterStaging(staging, result.files);
    if (entryExists(target)) throw new Error(`"${name}" already exists in that folder.`);
    if (workspaceHasResourceName(resourcesRoot, name)) {
      throw new Error(`A resource named "${name}" already exists elsewhere in this workspace.`);
    }
    fs.renameSync(staging, target);
    return result;
  } catch (error) {
    removeOwnedStaging(parent, staging);
    if (entryExists(target)) throw new Error(`"${name}" already exists in that folder.`);
    throw error;
  }
}
