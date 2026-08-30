import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";
import { AppUpdateController, appUpdateRestartBlockReason, compareStableVersions, type AppUpdateState } from "./appUpdate";

const info = (version: string): UpdateInfo => ({ version, files: [], path: "", sha512: "", releaseDate: "" });

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = true;
  disableWebInstaller = false;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls: Array<[boolean | undefined, boolean | undefined]> = [];
  checkResult = { isUpdateAvailable: false, updateInfo: info("1.0.0"), versionInfo: info("1.0.0") };

  async checkForUpdates() {
    this.checkCalls += 1;
    return this.checkResult;
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    return ["update.exe"];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installCalls.push([isSilent, isForceRunAfter]);
  }
}

function controller(fake: FakeUpdater, states: AppUpdateState[] = [], packaged = true) {
  return new AppUpdateController(fake as unknown as AppUpdater, "1.2.3", packaged, (state) => states.push(state), "win32");
}

test("stable semantic versions compare without treating v or build metadata as precedence", () => {
  assert.equal(compareStableVersions("1.2.3", "v1.2.4"), -1);
  assert.equal(compareStableVersions("2.0.0+build.4", "v2.0.0"), 0);
  assert.equal(compareStableVersions("10.0.0", "2.99.99"), 1);
  assert.throws(() => compareStableVersions("1.2.3-beta.1", "1.2.3"), /stable semantic versions/i);
});

test("development builds expose their version without enabling the installer", async () => {
  const fake = new FakeUpdater();
  const updater = controller(fake, [], false);
  assert.equal(updater.snapshot().phase, "disabled");
  assert.equal((await updater.checkForUpdates()).phase, "disabled");
  assert.equal(fake.checkCalls, 0);
});

test("packaged updater is manual, stable-only, and publishes availability", async () => {
  const fake = new FakeUpdater();
  const states: AppUpdateState[] = [];
  const updater = controller(fake, states);
  assert.equal(fake.autoDownload, false);
  assert.equal(fake.autoInstallOnAppQuit, false);
  assert.equal(fake.autoRunAppAfterInstall, true);
  assert.equal(fake.allowPrerelease, false);
  assert.equal(fake.allowDowngrade, false);
  assert.equal(fake.disableWebInstaller, true);

  fake.checkResult = { isUpdateAvailable: true, updateInfo: info("1.3.0"), versionInfo: info("1.3.0") };
  fake.checkForUpdates = async () => {
    fake.checkCalls += 1;
    fake.emit("checking-for-update");
    fake.emit("update-available", info("1.3.0"));
    return fake.checkResult;
  };
  const state = await updater.checkForUpdates();
  assert.equal(state.phase, "available");
  assert.equal(state.currentVersion, "1.2.3");
  assert.equal(state.latestVersion, "1.3.0");
  assert.equal(state.releaseUrl, "https://github.com/qbcore-framework/qb-studio/releases/tag/v1.3.0");
  assert.ok(states.some((entry) => entry.phase === "checking"));
});

test("download progress is normalized and a downloaded update restarts silently exactly once", async () => {
  const fake = new FakeUpdater();
  const states: AppUpdateState[] = [];
  const updater = controller(fake, states);
  fake.checkResult = { isUpdateAvailable: true, updateInfo: info("1.3.0"), versionInfo: info("1.3.0") };
  await updater.checkForUpdates();

  fake.downloadUpdate = async () => {
    fake.downloadCalls += 1;
    fake.emit("download-progress", { percent: 42.6, transferred: 426, total: 1000, bytesPerSecond: 20, delta: 20 } satisfies ProgressInfo);
    fake.emit("update-downloaded", info("1.3.0"));
    return ["update.exe"];
  };
  const ready = await updater.downloadUpdate();
  const progress = states.find((state) => state.phase === "downloading" && state.progressPercent === 43);
  assert.equal(progress?.transferredBytes, 426);
  assert.equal(progress?.totalBytes, 1000);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.progressPercent, 100);
  assert.equal(ready.transferredBytes, 1000);
  updater.restartToUpdate();
  updater.restartToUpdate();
  assert.deepEqual(fake.installCalls, [[true, true]]);
});

test("current releases settle up to date and automatic failures stay quiet", async () => {
  const fake = new FakeUpdater();
  const updater = controller(fake);
  assert.equal((await updater.checkForUpdates()).phase, "up-to-date");

  fake.checkForUpdates = async () => { throw new Error("offline"); };
  const quiet = await updater.checkForUpdates(false);
  assert.equal(quiet.phase, "idle");
  assert.equal(quiet.error, null);
  const visible = await updater.checkForUpdates(true);
  assert.equal(visible.phase, "error");
  assert.match(visible.error ?? "", /reach GitHub/i);
  assert.equal(visible.releaseUrl, "https://github.com/qbcore-framework/qb-studio/releases/latest");

  fake.checkForUpdates = async () => { throw new Error("Cannot find latest.yml in the latest release artifacts: HttpError 404"); };
  const missingMetadata = await updater.checkForUpdates(true);
  assert.match(missingMetadata.error ?? "", /missing update metadata/i);
});

test("invalid operations and untrusted release versions are rejected", async () => {
  const fake = new FakeUpdater();
  const updater = controller(fake);
  await assert.rejects(updater.downloadUpdate(), /check for an available update/i);
  assert.throws(() => updater.restartToUpdate(), /download the update/i);

  fake.checkResult = { isUpdateAvailable: true, updateInfo: info("1.3.0-beta.1"), versionInfo: info("1.3.0-beta.1") };
  const invalid = await updater.checkForUpdates();
  assert.equal(invalid.phase, "error");
  assert.match(invalid.error ?? "", /invalid release metadata/i);
});

test("restart authorization blocks premature installs and unsaved editor work", async () => {
  const fake = new FakeUpdater();
  const updater = controller(fake);
  assert.match(appUpdateRestartBlockReason(updater.snapshot(), 0) ?? "", /download the update/i);
  fake.checkResult = { isUpdateAvailable: true, updateInfo: info("1.3.0"), versionInfo: info("1.3.0") };
  await updater.checkForUpdates();
  await updater.downloadUpdate();
  assert.match(appUpdateRestartBlockReason(updater.snapshot(), 2) ?? "", /save or discard/i);
  assert.equal(appUpdateRestartBlockReason(updater.snapshot(), 0), null);
});

test("a synchronously reported installer failure restores retry state", async () => {
  const fake = new FakeUpdater();
  const updater = controller(fake);
  fake.checkResult = { isUpdateAvailable: true, updateInfo: info("1.3.0"), versionInfo: info("1.3.0") };
  await updater.checkForUpdates();
  await updater.downloadUpdate();
  fake.quitAndInstall = () => fake.emit("error", new Error("installer launch failed"));
  assert.equal(updater.restartToUpdate().phase, "error");

  await updater.checkForUpdates();
  await updater.downloadUpdate();
  fake.quitAndInstall = (isSilent?: boolean, isForceRunAfter?: boolean) => {
    fake.installCalls.push([isSilent, isForceRunAfter]);
  };
  updater.restartToUpdate();
  assert.deepEqual(fake.installCalls, [[true, true]]);
});
