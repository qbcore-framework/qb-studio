// Path containment for the agent's project file tools.
//
// Deliberately dependency-free (no electron imports) so it can be exercised
// directly by a test script — this is the boundary that stops "read a project
// file" from becoming "read any file on this machine", and it should not be
// something we only ever verify by reading it.

import fs from "node:fs";
import path from "node:path";

/** True when `child` is `parent` or sits underneath it. */
export function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves a caller-supplied relative path against `root`, refusing anything
 * that escapes it — `../..`, an absolute path, or a symlink pointing outside.
 * Throws on refusal; returns the absolute path on success.
 */
export function resolveInsideRoot(root: string, relative: string): string {
  if (typeof relative !== "string") throw new Error("Path must be a string.");
  const candidate = path.resolve(root, relative || ".");

  if (!contains(root, candidate)) {
    throw new Error(`Path "${relative}" is outside the project folder — refused.`);
  }

  // Walk every existing component with lstat. Checking only the final path is
  // insufficient for a new file below a dangling symlink/junction: mkdir()
  // would follow that link outside the project.
  const realRoot = fs.realpathSync(root);
  const relativeCandidate = path.relative(root, candidate);
  let current = realRoot;
  for (const part of relativeCandidate ? relativeCandidate.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Path "${relative}" contains a symbolic link or junction — refused.`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }

  // Re-check after resolving symlinks, so an existing leaf inside the tree
  // cannot point out of it.
  try {
    const realCandidate = fs.realpathSync(candidate);
    if (!contains(realRoot, realCandidate)) {
      throw new Error(`Path "${relative}" resolves outside the project folder — refused.`);
    }
  } catch (err) {
    // ENOENT is expected when writing a new file — the target doesn't exist yet.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return candidate;
}

/** Create a missing parent path one component at a time without traversing links. */
export function ensureParentInsideRoot(root: string, target: string): void {
  const realRoot = fs.realpathSync(root);
  if (!contains(realRoot, target)) throw new Error("Path is outside the project folder — refused.");
  const relative = path.relative(realRoot, path.dirname(target));
  let current = realRoot;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Refusing to create files through non-directory or linked path "${part}".`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      fs.mkdirSync(current);
    }
  }
}

/** A filename, not a path. Used for renderer rename operations. */
export function assertSafeBasename(name: string): string {
  if (typeof name !== "string") throw new Error("New name must be a string.");
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.length > 255 || path.basename(trimmed) !== trimmed) {
    throw new Error("New name must be a single valid filename.");
  }
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) throw new Error("New name contains invalid path characters.");
  if (/[. ]$/.test(trimmed)) throw new Error("New name cannot end with a dot or space on Windows.");
  const windowsStem = trimmed.split(".", 1)[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/.test(windowsStem)) {
    throw new Error("New name is reserved by Windows.");
  }
  return trimmed;
}
