import fs from "node:fs";
import path from "node:path";

import type { CfxTarget } from "./configStore";

/**
 * User-facing definition products. Runtime declarations needed by a game are
 * kept inside that game's pack so the language service never has a fourth,
 * ambiguous platform-only library to load.
 */
export type LuaDefinitionPackName = "fivem" | "redm" | "qbcore";

export function definitionPackNamesFor(target: CfxTarget): readonly LuaDefinitionPackName[] {
  return target === "redm" ? ["redm"] : ["fivem", "qbcore"];
}

/**
 * Resolve only application-owned definition folders. Callers intentionally
 * receive concrete paths rather than pack names, so the renderer cannot use
 * IPC to select arbitrary LuaLS library directories.
 */
export function resolveLuaDefinitionPackRoots(libraryRoot: string, target: CfxTarget): string[] {
  const root = path.resolve(libraryRoot);
  const packRoots = definitionPackNamesFor(target).map((pack) => path.join(root, pack));
  const missing = packRoots.filter((packRoot) => {
    try {
      return !fs.statSync(packRoot).isDirectory();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    const names = missing.map((packRoot) => path.basename(packRoot)).join(", ");
    throw new Error(`The bundled Lua definition pack${missing.length === 1 ? "" : "s"} (${names}) is missing. Reinstall QB Studio.`);
  }
  return packRoots;
}
