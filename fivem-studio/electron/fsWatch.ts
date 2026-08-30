// Watches the active profile folder so external changes (files moved/renamed/
// added/deleted outside Studio, e.g. in Windows Explorer) get reflected in the
// resource tree instead of only showing whatever was cached at last open.

import fs from "node:fs";
import type { BrowserWindow } from "electron";

import { invalidateConsoleSourceIndex } from "./consoleSourceResolver";

let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

export function stopWatching(): void {
  watcher?.close();
  watcher = null;
  invalidateConsoleSourceIndex();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

export function watchPath(dirPath: string | null, win: BrowserWindow): void {
  stopWatching();
  if (!dirPath || !fs.existsSync(dirPath)) return;

  try {
    // { recursive: true } is native on Windows/macOS but throws on Linux —
    // degrade to no live-watch there rather than crashing the app.
    watcher = fs.watch(dirPath, { recursive: true }, () => {
      // Resource discovery is cached, so invalidate immediately rather than
      // leaving a stale name mapping during the UI notification debounce.
      invalidateConsoleSourceIndex();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.send("fs:changed");
      }, 300);
    });
  } catch (err) {
    console.error("fivem-studio: filesystem watch failed for", dirPath, err);
  }
}
