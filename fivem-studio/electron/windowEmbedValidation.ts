export interface DiscoveredWindowCandidate {
  id: string;
  hwndId: string;
  pid: number;
  processName: string;
  expiresAt: number;
}

export interface CurrentWindowIdentity {
  pid: number;
  processName: string;
}

export type CfxWindowTarget = "legacy" | "enhanced" | "redm";

/** Only Cfx client/bootstrap and game-render processes may enter the renderer-visible candidate list. */
export function isCfxClientProcessName(processName: string): boolean {
  return /^(fivem|gta5|redm|rdr2)/i.test(processName.trim());
}

/** Distinguish the separate game surface from the FiveM/RedM browser process. */
export function isCfxGameRenderProcessName(processName: string, target: CfxWindowTarget): boolean {
  const name = processName.trim();
  if (target === "redm") return /^rdr2/i.test(name) || (/^redm/i.test(name) && /gtaprocess/i.test(name));
  return /^gta5/i.test(name) || (/^fivem/i.test(name) && /gtaprocess/i.test(name));
}

/** The launcher owns the server browser before the separate game-render process exists. */
export function isCfxBootstrapProcessName(processName: string, target: CfxWindowTarget): boolean {
  const name = processName.trim();
  return target === "redm" ? /^redm\.exe$/i.test(name) : /^fivem\.exe$/i.test(name);
}

export function selectAutoAttachCandidate<T extends { processName: string }>(
  candidates: readonly T[],
  target: CfxWindowTarget,
): T | null {
  return candidates.find((candidate) => isCfxGameRenderProcessName(candidate.processName, target))
    ?? candidates.find((candidate) => isCfxBootstrapProcessName(candidate.processName, target))
    ?? null;
}

/** Candidate IDs are renderer-safe handles; the HWND itself remains main-process-only. */
export function getFreshCandidate(
  candidates: ReadonlyMap<string, DiscoveredWindowCandidate>,
  id: string,
  now = Date.now(),
): DiscoveredWindowCandidate | null {
  const candidate = candidates.get(id);
  return candidate && candidate.expiresAt >= now ? candidate : null;
}

/** A window handle can be reused after a process exits, so PID alone is not enough. */
export function matchesDiscoveredWindow(
  candidate: DiscoveredWindowCandidate,
  current: CurrentWindowIdentity,
): boolean {
  return (
    current.pid === candidate.pid &&
    current.processName.trim().toLowerCase() === candidate.processName.trim().toLowerCase()
  );
}
