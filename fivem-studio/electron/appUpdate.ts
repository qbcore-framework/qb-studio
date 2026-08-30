import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";

const RELEASE_PAGE_PREFIX = "https://github.com/qbcore-framework/qb-studio/releases/tag/v";
const LATEST_RELEASE_PAGE = "https://github.com/qbcore-framework/qb-studio/releases/latest";
const STABLE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;

export type AppUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  progressPercent: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  error: string | null;
}

export function appUpdateRestartBlockReason(state: AppUpdateState, dirtyFileCount: number): string | null {
  if (state.phase !== "ready") return "Download the update before restarting to install it.";
  if (dirtyFileCount > 0) return "Save or discard open editor changes before restarting to update.";
  return null;
}

type StableVersion = readonly [major: number, minor: number, patch: number];

function parseStableVersion(value: string): StableVersion | null {
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return version.every(Number.isSafeInteger) ? version : null;
}

function normalizedStableVersion(value: string): string | null {
  const parsed = parseStableVersion(value);
  return parsed ? parsed.join(".") : null;
}

export function compareStableVersions(left: string, right: string): number {
  const leftVersion = parseStableVersion(left);
  const rightVersion = parseStableVersion(right);
  if (!leftVersion || !rightVersion) throw new Error("Only stable semantic versions can be compared.");
  for (let index = 0; index < leftVersion.length; index += 1) {
    if (leftVersion[index] !== rightVersion[index]) return leftVersion[index] < rightVersion[index] ? -1 : 1;
  }
  return 0;
}

function releaseUrl(version: string): string | null {
  const normalized = normalizedStableVersion(version);
  return normalized ? `${RELEASE_PAGE_PREFIX}${normalized}` : null;
}

function finiteNonNegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function readableUpdaterError(error: unknown): string {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown update error.";
  const normalized = detail.replace(/\\[rn]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (/latest\.yml|channel file|404.*release artifacts/i.test(normalized)) {
    return "The latest QB Studio release is missing update metadata. Please try again later.";
  }
  if (/sha-?512|checksum|integrity|digest/i.test(normalized)) {
    return "The downloaded update did not pass its integrity check and was not installed.";
  }
  if (/signature|publisher|ERR_UPDATER_INVALID_SIGNATURE/i.test(normalized)) {
    return "The downloaded update could not be verified and was not installed.";
  }
  if (/cancel/i.test(normalized)) return "The update download was cancelled. You can try again when ready.";
  if (/invalid release version|invalid release metadata/i.test(normalized)) {
    return "The update service returned invalid release metadata. No update was downloaded.";
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network|offline|internet/i.test(normalized)) {
    return "QB Studio couldn't reach GitHub. Check your connection and try again.";
  }
  return "QB Studio couldn't complete the update. Try again or view the release on GitHub.";
}

/**
 * Owns the packaged Windows updater lifecycle. The renderer receives only a
 * serializable snapshot and fixed operations; it can never choose a feed URL,
 * installer path, or command line.
 */
export class AppUpdateController {
  private state: AppUpdateState;
  private readonly supported: boolean;
  private surfaceErrors = false;
  private checkPromise: Promise<AppUpdateState> | null = null;
  private downloadPromise: Promise<AppUpdateState> | null = null;
  private installRequested = false;

  constructor(
    private readonly updater: AppUpdater,
    currentVersion: string,
    isPackaged: boolean,
    private readonly onStateChange: (state: AppUpdateState) => void = () => undefined,
    platform: NodeJS.Platform = process.platform,
  ) {
    const normalizedCurrent = normalizedStableVersion(currentVersion) ?? currentVersion;
    this.supported = isPackaged && platform === "win32" && normalizedStableVersion(currentVersion) !== null;
    this.state = {
      phase: this.supported ? "idle" : "disabled",
      currentVersion: normalizedCurrent,
      latestVersion: null,
      releaseUrl: this.supported ? LATEST_RELEASE_PAGE : null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      error: null,
    };
    if (!this.supported) return;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;

    updater.on("checking-for-update", () => {
      this.publish({ phase: "checking", error: null, progressPercent: null, transferredBytes: null, totalBytes: null });
    });
    updater.on("update-available", (info) => this.markAvailable(info));
    updater.on("update-not-available", (info) => this.markCurrent(info));
    updater.on("download-progress", (progress) => this.markProgress(progress));
    updater.on("update-downloaded", (info) => this.markReady(info));
    updater.on("update-cancelled", () => this.fail(new Error("The update download was cancelled.")));
    updater.on("error", (error) => this.fail(error));
  }

  snapshot(): AppUpdateState {
    return { ...this.state };
  }

  async checkForUpdates(manual = true): Promise<AppUpdateState> {
    if (!this.supported) return this.snapshot();
    if (this.checkPromise) {
      if (manual) this.surfaceErrors = true;
      return this.checkPromise;
    }
    this.surfaceErrors = manual;
    this.publish({
      phase: "checking",
      latestVersion: null,
      releaseUrl: LATEST_RELEASE_PAGE,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      error: null,
    });
    this.checkPromise = (async () => {
      try {
        const result = await this.updater.checkForUpdates();
        // electron-updater emits one of the availability events. The fallback
        // keeps the state deterministic for provider implementations that only
        // resolve the result object.
        if (this.state.phase === "checking") {
          if (!result) this.publish({ phase: "idle" });
          else if (result.isUpdateAvailable) this.markAvailable(result.updateInfo);
          else this.markCurrent(result.updateInfo);
        }
      } catch (error) {
        this.fail(error);
      } finally {
        this.checkPromise = null;
      }
      return this.snapshot();
    })();
    return this.checkPromise;
  }

  async downloadUpdate(): Promise<AppUpdateState> {
    if (!this.supported) throw new Error("Application updates are available only in an installed Windows release.");
    if (this.state.phase === "ready") return this.snapshot();
    if (this.state.phase !== "available" && this.state.phase !== "downloading") {
      throw new Error("Check for an available update before downloading it.");
    }
    if (this.downloadPromise) return this.downloadPromise;
    this.surfaceErrors = true;
    this.publish({ phase: "downloading", progressPercent: 0, transferredBytes: 0, totalBytes: null, error: null });
    this.downloadPromise = (async () => {
      try {
        await this.updater.downloadUpdate();
        if (this.state.phase === "downloading") {
          this.publish({ phase: "ready", progressPercent: 100, error: null });
        }
      } catch (error) {
        this.fail(error);
      } finally {
        this.downloadPromise = null;
      }
      return this.snapshot();
    })();
    return this.downloadPromise;
  }

  restartToUpdate(): AppUpdateState {
    if (!this.supported || this.state.phase !== "ready") {
      throw new Error("Download the update before restarting to install it.");
    }
    if (this.installRequested) return this.snapshot();
    this.installRequested = true;
    try {
      // Silent NSIS installation plus force-run-after gives the familiar
      // "Restart to update" experience instead of reopening an installer UI.
      this.updater.quitAndInstall(true, true);
    } catch (error) {
      this.installRequested = false;
      this.fail(error);
      throw error;
    }
    return this.snapshot();
  }

  private markAvailable(info: UpdateInfo): void {
    const latestVersion = normalizedStableVersion(info.version);
    if (!latestVersion || compareStableVersions(this.state.currentVersion, latestVersion) >= 0) {
      this.fail(new Error("The update service returned an invalid release version."));
      return;
    }
    this.publish({
      phase: "available",
      latestVersion,
      releaseUrl: releaseUrl(latestVersion),
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      error: null,
    });
  }

  private markCurrent(info: UpdateInfo): void {
    const latestVersion = normalizedStableVersion(info.version) ?? this.state.currentVersion;
    this.publish({
      phase: "up-to-date",
      latestVersion,
      releaseUrl: releaseUrl(latestVersion),
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      error: null,
    });
  }

  private markProgress(progress: ProgressInfo): void {
    if (this.state.phase !== "downloading") return;
    const rawPercent = finiteNonNegative(progress.percent);
    const progressPercent = rawPercent === null ? null : Math.min(100, Math.round(rawPercent));
    const transferredBytes = finiteNonNegative(progress.transferred);
    const totalBytes = finiteNonNegative(progress.total);
    this.publish({ progressPercent, transferredBytes, totalBytes });
  }

  private markReady(info: UpdateInfo): void {
    const latestVersion = normalizedStableVersion(info.version) ?? this.state.latestVersion;
    this.publish({
      phase: "ready",
      latestVersion,
      releaseUrl: latestVersion ? releaseUrl(latestVersion) : this.state.releaseUrl,
      progressPercent: 100,
      transferredBytes: this.state.totalBytes ?? this.state.transferredBytes,
      error: null,
    });
  }

  private fail(error: unknown): void {
    this.installRequested = false;
    if (!this.surfaceErrors) {
      this.publish({
        phase: "idle",
        latestVersion: null,
        releaseUrl: LATEST_RELEASE_PAGE,
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        error: null,
      });
      return;
    }
    this.publish({
      phase: "error",
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      error: readableUpdaterError(error),
    });
  }

  private publish(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.snapshot());
  }
}
