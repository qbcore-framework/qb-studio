// Places an external FiveM/RedM window in Studio's viewport using raw Win32
// window management. Launcher/browser windows become real children; game render
// surfaces use an owned borderless overlay so they retain raw keyboard input.
// SetParent, SetWindowLongPtr and SetWindowPos are called through user32.dll. This
// does not touch the target process's memory in any way; it's the same kind
// of operation any window-docking/tiling utility performs.
//
// Windows-only. The Cfx client must be running windowed/borderless — an exclusive
// fullscreen window generally can't be reparented as a child window.
//
// The GetWindowThreadProcessId/GetWindowText pattern below follows koffi's
// own documented Win32 example (see node_modules/koffi/doc/output.md).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
  getFreshCandidate,
  isCfxClientProcessName,
  matchesDiscoveredWindow,
  type DiscoveredWindowCandidate,
} from "./windowEmbedValidation";

// Electron's main process is CommonJS, while Koffi exposes separate ESM and
// CommonJS entry points. A type query keeps its public API without asking
// TypeScript's Node16 resolver to emit an invalid static ESM import here.
const koffi = require("koffi") as typeof import("koffi", { with: { "resolution-mode": "import" } }).default;

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
const HWND = koffi.alias("HWND", HANDLE);

const GetTopWindow = user32.func("HWND __stdcall GetTopWindow(HWND hWnd)");
const GetWindow = user32.func("HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)");
const IsWindow = user32.func("bool __stdcall IsWindow(HWND hWnd)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(HWND hWnd)");
const GetWindowThreadProcessId = user32.func(
  "uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)",
);
const GetWindowTextLength = user32.func("int __stdcall GetWindowTextLengthA(HWND hWnd)");
const GetWindowText = user32.func("int __stdcall GetWindowTextA(HWND hWnd, _Out_ uint8_t *lpString, int nMaxCount)");
const GetWindowLongPtr = user32.func("int64_t __stdcall GetWindowLongPtrA(HWND hWnd, int nIndex)");
const SetWindowLongPtr = user32.func("int64_t __stdcall SetWindowLongPtrA(HWND hWnd, int nIndex, int64_t dwNewLong)");
const SetParent = user32.func("HWND __stdcall SetParent(HWND hWndChild, HWND hWndNewParent)");
const SetWindowPos = user32.func(
  "bool __stdcall SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)",
);
const GetParent = user32.func("HWND __stdcall GetParent(HWND hWnd)");
const RECT = koffi.struct("WINDOW_EMBED_RECT", {
  left: "long",
  top: "long",
  right: "long",
  bottom: "long",
});
const POINT = koffi.struct("WINDOW_EMBED_POINT", { x: "long", y: "long" });
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(HWND hWnd, _Out_ WINDOW_EMBED_RECT *lpRect)");
const ScreenToClient = user32.func("bool __stdcall ScreenToClient(HWND hWnd, _Inout_ WINDOW_EMBED_POINT *lpPoint)");
const ClientToScreen = user32.func("bool __stdcall ClientToScreen(HWND hWnd, _Inout_ WINDOW_EMBED_POINT *lpPoint)");
const ShowWindow = user32.func("bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(HWND hWnd)");
const SetActiveWindow = user32.func("HWND __stdcall SetActiveWindow(HWND hWnd)");
const SetFocus = user32.func("HWND __stdcall SetFocus(HWND hWnd)");
const AttachThreadInput = user32.func("bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)");
const GetCurrentThreadId = kernel32.func("uint32_t __stdcall GetCurrentThreadId()");

// DPI-awareness-context APIs (Windows 10 1607+) — guarded because older Windows lacks them.
let GetWindowDpiAwarenessContext: ((hwnd: bigint) => bigint) | null = null;
let SetThreadDpiAwarenessContext: ((ctx: bigint) => bigint) | null = null;
try {
  GetWindowDpiAwarenessContext = user32.func("void * __stdcall GetWindowDpiAwarenessContext(HWND hWnd)");
  SetThreadDpiAwarenessContext = user32.func("void * __stdcall SetThreadDpiAwarenessContext(void *dpiContext)");
} catch {
  // Pre-1607 Windows — mixed DPI-awareness positioning quirks below just won't be compensated for.
}

const GW_HWNDNEXT = 2;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;

export interface WindowCandidate {
  id: string;
  title: string;
  processName: string;
  pid: number;
}

const CANDIDATE_TTL_MS = 60_000;
const discoveredCandidates = new Map<string, DiscoveredWindowCandidate>();

function getWindowTitle(hwnd: bigint): string {
  const length = GetWindowTextLength(hwnd);
  if (length <= 0) return "";
  const buf = Buffer.alloc(length + 1);
  const written = GetWindowText(hwnd, buf, buf.length);
  return written > 0 ? (koffi.decode(buf, "char", written) as string) : "";
}

function getWindowThreadAndPid(hwnd: bigint): { tid: number; pid: number } {
  const out = [0];
  const tid = GetWindowThreadProcessId(hwnd, out) as number; // return value is the thread id; the out-param is the pid
  return { tid, pid: out[0] };
}

/** PID -> image name (e.g. "FiveM_GTAProcess.exe" or "RDR2.exe"), via `tasklist` — far simpler than the extra
 * Win32 calls (OpenProcess + QueryFullProcessImageName) it'd otherwise take to get this ourselves. */
function processNames(): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile("tasklist", ["/fo", "csv", "/nh"], (err, stdout) => {
      const map = new Map<number, string>();
      if (err || !stdout) {
        resolve(map);
        return;
      }
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
        if (!cols || cols.length < 2) continue;
        const pid = Number(cols[1]);
        if (Number.isFinite(pid)) map.set(pid, cols[0]);
      }
      resolve(map);
    });
  });
}

export async function listCandidates(): Promise<WindowCandidate[]> {
  const names = await processNames();
  const results: WindowCandidate[] = [];
  discoveredCandidates.clear();

  for (let hwnd: bigint | null = GetTopWindow(null); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT)) {
    if (!IsWindowVisible(hwnd)) continue;

    const { pid } = getWindowThreadAndPid(hwnd);
    if (pid === process.pid) continue; // never offer Studio's own window, however it ends up (re)named

    const processName = names.get(pid) ?? "";
    // Match on process name only — matching on window title too (as a first cut) turned out to
    // false-positive on anything with "fivem" or "redm" in its title: Explorer windows browsing a
    // folder named similarly, Windows' own jump-list popups, etc. The game render surfaces run as
    // GTA5*/RDR2* processes rather than the FiveM.exe/RedM.exe bootstrapper, so include both families.
    if (!isCfxClientProcessName(processName)) continue;

    const title = getWindowTitle(hwnd);
    const id = randomUUID();
    const record: DiscoveredWindowCandidate = {
      id,
      hwndId: hwnd.toString(),
      pid,
      processName,
      expiresAt: Date.now() + CANDIDATE_TTL_MS,
    };
    discoveredCandidates.set(id, record);
    results.push({ id, title, processName, pid });
  }

  // The actual game render surface is far more likely to be the wanted window than the Cfx
  // bootstrapper window — surface GTA5*/RDR2* processes first.
  results.sort((a, b) => Number(/^(gta5|rdr2)/i.test(b.processName)) - Number(/^(gta5|rdr2)/i.test(a.processName)));

  return results;
}

/**
 * GTA5 (and by extension FiveM's Enhanced-edition render process) pauses/blanks its own rendering
 * when it isn't the focused window — a WS_CHILD window we've just reparented doesn't have real OS
 * keyboard focus, so it stays in that paused state (a black box) until something focuses it, which
 * is exactly what alt-tabbing onto it manually does. SetForegroundWindow/SetFocus only work across
 * threads if the calling and target threads share input state, hence AttachThreadInput around them
 * — the standard, well-documented pattern for focusing a window owned by another process/thread.
 */
function focusEmbeddedWindow(value: NonNullable<typeof attached>): void {
  try {
    const targetTid = getWindowThreadAndPid(value.hwnd).tid;
    const hostTid = getWindowThreadAndPid(value.parentHwnd).tid;
    const currentTid = GetCurrentThreadId() as number;
    const attachHost = hostTid !== 0 && hostTid !== currentTid;
    const attachTarget = targetTid !== 0 && targetTid !== currentTid;
    if (attachHost) AttachThreadInput(currentTid, hostTid, true);
    if (attachTarget) AttachThreadInput(currentTid, targetTid, true);
    const foregroundHwnd = value.mode === "overlay" ? value.hwnd : value.parentHwnd;
    SetForegroundWindow(foregroundHwnd);
    SetActiveWindow(foregroundHwnd);
    SetFocus(value.hwnd);
    if (attachTarget) AttachThreadInput(currentTid, targetTid, false);
    if (attachHost) AttachThreadInput(currentTid, hostTid, false);
  } catch {
    // best-effort — worst case the user has to click/alt-tab into it once, same as before this fix
  }
}

function focusTopLevelWindow(hwnd: bigint): void {
  try {
    const targetTid = getWindowThreadAndPid(hwnd).tid;
    const currentTid = GetCurrentThreadId() as number;
    const needsAttach = targetTid !== 0 && targetTid !== currentTid;
    if (needsAttach) AttachThreadInput(currentTid, targetTid, true);
    SetForegroundWindow(hwnd);
    SetFocus(hwnd);
    if (needsAttach) AttachThreadInput(currentTid, targetTid, false);
  } catch {
    // best-effort restoration for a manually detached external window
  }
}

/**
 * If Studio and the target window declare different DPI awareness (common: a CEF-based UI window
 * that hasn't opted into per-monitor DPI awareness, vs. our own per-monitor-aware Electron window),
 * Windows silently rescales the coordinates a differently-aware process passes to SetWindowPos —
 * producing exactly the kind of badly-distorted (e.g. squashed to a sliver) sizing seen on FiveM's
 * own menu/server-browser window. Temporarily matching our thread's DPI-awareness context to the
 * target's for the duration of the call is the documented fix for this cross-process scenario.
 */
function withTargetDpiAwareness<T>(hwnd: bigint, fn: () => T): T {
  if (!GetWindowDpiAwarenessContext || !SetThreadDpiAwarenessContext) return fn();
  let previous: bigint | null = null;
  try {
    const targetContext = GetWindowDpiAwarenessContext(hwnd);
    if (targetContext) previous = SetThreadDpiAwarenessContext(targetContext);
  } catch {
    return fn();
  }
  try {
    return fn();
  } finally {
    if (previous !== null) {
      try {
        SetThreadDpiAwarenessContext(previous);
      } catch {
        // best-effort restore
      }
    }
  }
}

interface AttachedWindow {
  hwnd: bigint;
  parentHwnd: bigint;
  mode: "child" | "overlay";
  pid: number;
  processName: string;
  title: string;
  originalStyle: number;
  originalExStyle: number;
  originalParent: bigint | null;
  originalRect: { x: number; y: number; width: number; height: number };
  wasOriginallyVisible: boolean;
  embeddedStyle: number;
  embeddedExStyle: number;
  wasVisible: boolean;
  lastRect: { x: number; y: number; width: number; height: number } | null;
}

let attached: AttachedWindow | null = null;
let parkedLauncher: AttachedWindow | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

function stopMaintenanceTimer(): void {
  if (maintenanceTimer === null) return;
  clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}

function attachedWindowStillOwned(value: NonNullable<typeof attached>): boolean {
  if (!IsWindow(value.hwnd)) return false;
  const { tid, pid } = getWindowThreadAndPid(value.hwnd);
  return tid !== 0 && pid === value.pid;
}

function isBootstrapProcessName(processName: string): boolean {
  return /^(fivem|redm)\.exe$/i.test(processName.trim());
}

function isGameRenderProcessName(processName: string): boolean {
  const name = processName.trim();
  return /^(gta5|rdr2)/i.test(name) || /gtaprocess/i.test(name);
}

function readWindowRect(hwnd: bigint): AttachedWindow["originalRect"] {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetWindowRect(hwnd, rect)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

function getWindowOwner(hwnd: bigint): bigint | null {
  const raw = GetWindowLongPtr(hwnd, GWLP_HWNDPARENT) as number | bigint;
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  return value === 0n ? null : value;
}

function setWindowOwner(hwnd: bigint, owner: bigint | null): void {
  SetWindowLongPtr(hwnd, GWLP_HWNDPARENT, owner ?? 0n);
}

function parkAttachedLauncher(): void {
  if (!attached) return;
  ShowWindow(attached.hwnd, SW_HIDE);
  attached.wasVisible = false;
  parkedLauncher = attached;
  attached = null;
}

function restoreExternalWindow(value: AttachedWindow, focus: boolean): void {
  if (!attachedWindowStillOwned(value)) return;
  SetWindowLongPtr(value.hwnd, GWL_STYLE, value.originalStyle);
  SetWindowLongPtr(value.hwnd, GWL_EXSTYLE, value.originalExStyle);
  if (value.mode === "overlay") setWindowOwner(value.hwnd, value.originalParent);
  else SetParent(value.hwnd, value.originalParent);
  const rect = value.originalRect;
  withTargetDpiAwareness(value.hwnd, () =>
    SetWindowPos(
      value.hwnd,
      null,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE,
    ),
  );
  ShowWindow(value.hwnd, value.wasOriginallyVisible ? SW_SHOWNOACTIVATE : SW_HIDE);
  if (focus && value.wasOriginallyVisible) focusTopLevelWindow(value.hwnd);
}

function resumeParkedLauncher(): boolean {
  const value = parkedLauncher;
  parkedLauncher = null;
  if (!value || !attachedWindowStillOwned(value) || !value.lastRect) return false;
  attached = value;
  value.wasVisible = true;
  SetWindowLongPtr(value.hwnd, GWL_STYLE, value.embeddedStyle);
  SetWindowLongPtr(value.hwnd, GWL_EXSTYLE, value.embeddedExStyle);
  if (value.mode === "overlay") setWindowOwner(value.hwnd, value.parentHwnd);
  else SetParent(value.hwnd, value.parentHwnd);
  positionAttachedWindow(value, value.lastRect);
  ShowWindow(value.hwnd, SW_SHOWNOACTIVATE);
  focusEmbeddedWindow(value);
  return true;
}

function positionAttachedWindow(
  value: NonNullable<typeof attached>,
  rect: { x: number; y: number; width: number; height: number },
): void {
  withTargetDpiAwareness(value.hwnd, () => {
    const topLeft = { x: rect.x, y: rect.y };
    if (value.mode === "overlay" && !ClientToScreen(value.parentHwnd, topLeft)) return false;
    SetWindowPos(
      value.hwnd,
      null,
      topLeft.x,
      topLeft.y,
      rect.width,
      rect.height,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );
    return true;
  });
}

function currentAttachedRect(value: NonNullable<typeof attached>): AttachedWindow["lastRect"] {
  return withTargetDpiAwareness(value.hwnd, () => {
    const windowRect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!GetWindowRect(value.hwnd, windowRect)) return null;
    const topLeft = { x: windowRect.left, y: windowRect.top };
    if (!ScreenToClient(value.parentHwnd, topLeft)) return null;
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: windowRect.right - windowRect.left,
      height: windowRect.bottom - windowRect.top,
    };
  });
}

function maintainAttachment(): boolean {
  const value = attached;
  if (!value) {
    if (resumeParkedLauncher()) return true;
    stopMaintenanceTimer();
    return false;
  }
  if (!attachedWindowStillOwned(value)) {
    attached = null;
    if (resumeParkedLauncher()) return true;
    stopMaintenanceTimer();
    return false;
  }

  // GTA can restore fullscreen state well after its render window appears.
  // Keep this repair in Electron's main process: once a native surface covers
  // Chromium, renderer timers and IPC health polling are not dependable.
  if (value.wasVisible && value.lastRect) {
    const actualParent = value.mode === "overlay" ? getWindowOwner(value.hwnd) : GetParent(value.hwnd);
    const parentChanged = actualParent !== value.parentHwnd;
    const actualStyle = Number(GetWindowLongPtr(value.hwnd, GWL_STYLE)) >>> 0;
    const styleChanged = actualStyle !== value.embeddedStyle;
    const actualExStyle = Number(GetWindowLongPtr(value.hwnd, GWL_EXSTYLE)) >>> 0;
    const exStyleChanged = actualExStyle !== value.embeddedExStyle;
    if (styleChanged) SetWindowLongPtr(value.hwnd, GWL_STYLE, value.embeddedStyle);
    if (exStyleChanged) SetWindowLongPtr(value.hwnd, GWL_EXSTYLE, value.embeddedExStyle);
    if (parentChanged) {
      if (value.mode === "overlay") setWindowOwner(value.hwnd, value.parentHwnd);
      else SetParent(value.hwnd, value.parentHwnd);
    }
    const actual = currentAttachedRect(value);
    const desired = value.lastRect;
    if (
      parentChanged
      ||
      styleChanged
      ||
      exStyleChanged
      ||
      !actual
      || actual.x !== desired.x
      || actual.y !== desired.y
      || actual.width !== desired.width
      || actual.height !== desired.height
    ) {
      positionAttachedWindow(value, desired);
    }
  }
  return true;
}

function startMaintenanceTimer(): void {
  if (maintenanceTimer !== null) return;
  maintenanceTimer = setInterval(() => {
    try {
      maintainAttachment();
    } catch {
      // The renderer's status call still reports a stale/dead HWND. A single
      // best-effort native repair failure must not terminate the main process.
    }
  }, 250);
  maintenanceTimer.unref?.();
}

export function status(): { attached: boolean; pid?: number; processName?: string; title?: string } {
  const isAttached = maintainAttachment();
  return isAttached && attached
    ? { attached: true, pid: attached.pid, processName: attached.processName, title: attached.title }
    : { attached: false };
}

async function resolveCurrentCandidate(candidateId: string): Promise<{ hwnd: bigint; candidate: DiscoveredWindowCandidate } | null> {
  const candidate = getFreshCandidate(discoveredCandidates, candidateId);
  if (!candidate) return null;

  let hwnd: bigint;
  try {
    hwnd = BigInt(candidate.hwndId);
  } catch {
    return null;
  }
  if (!IsWindow(hwnd)) return null;

  const { tid, pid } = getWindowThreadAndPid(hwnd);
  if (tid === 0 || pid === 0) return null;
  const names = await processNames();
  if (candidate.expiresAt < Date.now()) return null;
  const processName = names.get(pid);
  if (!processName || !matchesDiscoveredWindow(candidate, { pid, processName })) return null;
  return { hwnd, candidate };
}

export async function attach(candidateId: string, win: BrowserWindow): Promise<{ ok: boolean; error?: string }> {
  try {
    // Resolve after scanning and immediately before mutation. This blocks both
    // renderer-invented HWNDs and a stale/reused HWND from another process.
    const initial = await resolveCurrentCandidate(candidateId);
    if (!initial) return { ok: false, error: "That window is no longer an approved Cfx client candidate. Scan again and select it from the list." };

    // detach() can take long enough for a target to exit, so make the final
    // identity check directly before changing its parent or style.
    const current = await resolveCurrentCandidate(candidateId);
    if (!current || current.hwnd !== initial.hwnd) {
      return { ok: false, error: "That window changed before it could be attached. Scan again and select it from the list." };
    }

    const hwnd = current.hwnd;
    const promoteLauncher = Boolean(
      attached
      && isBootstrapProcessName(attached.processName)
      && isGameRenderProcessName(current.candidate.processName),
    );
    if (promoteLauncher) parkAttachedLauncher();
    else detach();

    const mode: AttachedWindow["mode"] = isGameRenderProcessName(current.candidate.processName) ? "overlay" : "child";
    const originalStyle = Number(GetWindowLongPtr(hwnd, GWL_STYLE)) >>> 0;
    const originalExStyle = Number(GetWindowLongPtr(hwnd, GWL_EXSTYLE)) >>> 0;
    const originalParent = mode === "overlay" ? getWindowOwner(hwnd) : GetParent(hwnd);
    const originalRect = readWindowRect(hwnd);
    const wasOriginallyVisible = Boolean(IsWindowVisible(hwnd));
    const newStyle = mode === "overlay"
      ? ((originalStyle & ~WS_CHILD & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU & ~WS_MINIMIZEBOX & ~WS_MAXIMIZEBOX) | WS_POPUP) >>> 0
      : ((originalStyle & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU & ~WS_MINIMIZEBOX & ~WS_MAXIMIZEBOX) | WS_CHILD) >>> 0;
    const newExStyle = mode === "overlay"
      ? ((originalExStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW) >>> 0
      : originalExStyle;
    SetWindowLongPtr(hwnd, GWL_STYLE, newStyle);
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, newExStyle);

    const parentHandle = win.getNativeWindowHandle().readBigUInt64LE(0);
    if (mode === "overlay") setWindowOwner(hwnd, parentHandle);
    else SetParent(hwnd, parentHandle);
    withTargetDpiAwareness(hwnd, () =>
      SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE),
    );

    attached = {
      hwnd,
      parentHwnd: parentHandle,
      mode,
      pid: current.candidate.pid,
      processName: current.candidate.processName,
      title: getWindowTitle(hwnd),
      originalStyle,
      originalExStyle,
      originalParent,
      originalRect,
      wasOriginallyVisible,
      embeddedStyle: newStyle,
      embeddedExStyle: newExStyle,
      wasVisible: false,
      lastRect: null,
    };
    startMaintenanceTimer();
    return { ok: true };
  } catch (err) {
    attached = null;
    if (resumeParkedLauncher()) startMaintenanceTimer();
    return { ok: false, error: (err as Error).message };
  }
}

export function setRect(x: number, y: number, width: number, height: number, visible: boolean): void {
  if (!attached) return;
  if (!attachedWindowStillOwned(attached)) {
    attached = null;
    return;
  }
  if (!visible) {
    if (attached.wasVisible) ShowWindow(attached.hwnd, SW_HIDE);
    attached.wasVisible = false;
    return;
  }
  const nextRect = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
  const risingEdge = !attached.wasVisible; // covers both the initial attach and switching back into the tab after hiding
  const rectChanged =
    !attached.lastRect ||
    attached.lastRect.x !== nextRect.x ||
    attached.lastRect.y !== nextRect.y ||
    attached.lastRect.width !== nextRect.width ||
    attached.lastRect.height !== nextRect.height;
  if (rectChanged) {
    positionAttachedWindow(attached, nextRect);
    attached.lastRect = nextRect;
  }
  if (risingEdge) ShowWindow(attached.hwnd, SW_SHOWNOACTIVATE);
  attached.wasVisible = true;
  if (risingEdge) focusEmbeddedWindow(attached);
}

export function detach(): void {
  if (!attached && !parkedLauncher) {
    stopMaintenanceTimer();
    return;
  }
  const previous = attached;
  const previousParked = parkedLauncher;
  attached = null;
  parkedLauncher = null;
  stopMaintenanceTimer();
  try {
    if (previousParked) restoreExternalWindow(previousParked, false);
    if (previous) restoreExternalWindow(previous, true);
  } catch {
    // best-effort — if the target process is already gone there's nothing left to restore
  }
}

/** Re-focus the currently-embedded window when Studio itself regains OS focus (e.g. alt-tabbing
 * back from another app) — the internal tab-switch rising-edge in setRect() doesn't cover this,
 * since Studio's own window can regain focus without any of our tabs changing. */
export function onHostFocusGained(): void {
  if (!attached || !attached.wasVisible || !attachedWindowStillOwned(attached)) return;
  const value = attached;
  setTimeout(() => {
    if (attached === value && value.wasVisible && attachedWindowStillOwned(value)) {
      maintainAttachment();
      // A game overlay becomes the foreground input window when the user clicks
      // it. Do not steal focus back from Studio's editor/chat merely because the
      // owner window activated. True child embeds still need explicit focus.
      if (value.mode === "child") focusEmbeddedWindow(value);
    }
  }, 50).unref?.();
}
