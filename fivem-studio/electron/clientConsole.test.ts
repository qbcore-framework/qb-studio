import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClientConsoleReader, clientLogDirectoryGroups, findLatestClientLog } from "./clientConsole";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-client-console-"));
}

test("discovers Legacy and RedM logs beside their configured launchers", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [target, product, executable] of [
    ["legacy", "FiveM", "FiveM.exe"],
    ["redm", "RedM", "RedM.exe"],
  ] as const) {
    const install = path.join(root, product);
    const logs = path.join(install, `${product}.app`, "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(install, executable), "launcher");
    const older = path.join(logs, "CitizenFX_log_2026-01-01T010101.log");
    const newer = path.join(logs, "CitizenFX_log_2026-01-02T010101.log");
    fs.writeFileSync(older, "old");
    fs.writeFileSync(newer, "new");
    fs.utimesSync(older, new Date(1_000), new Date(1_000));
    fs.utimesSync(newer, new Date(2_000), new Date(2_000));
    assert.equal(findLatestClientLog({
      target,
      configuredExecutable: path.join(install, executable),
      localAppData: root,
    }), newer);
  }
});

test("discovers Enhanced game logs in the documented roaming AppData directory", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logDirectory = path.join(root, "FiveM for GTAV Enhanced", "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const game = path.join(logDirectory, "fivem-for-gtav-enhanced.log-2026-08-30_21-34-02.log");
  fs.writeFileSync(game, "game output");
  fs.writeFileSync(path.join(logDirectory, "fivem-launcher-2026-08-30_21-32-35.log"), "launcher output");
  fs.writeFileSync(path.join(logDirectory, "cef-2026-08-30_21-34-03.log"), "cef output");
  assert.equal(findLatestClientLog({
    target: "enhanced",
    configuredExecutable: null,
    appData: root,
  }), game);

  const current = path.join(logDirectory, "fivem-for-gtav-enhanced.log");
  fs.writeFileSync(current, "current game output");
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(current, future, future);
  assert.equal(findLatestClientLog({
    target: "enhanced",
    configuredExecutable: null,
    appData: root,
  }), current);
});

test("prefers the configured installation and ignores unrelated and linked files", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const customInstall = path.join(root, "custom");
  const customLogs = path.join(customInstall, "FiveM.app", "logs");
  const conventionalLogs = path.join(root, "local", "FiveM", "FiveM.app", "logs");
  fs.mkdirSync(customLogs, { recursive: true });
  fs.mkdirSync(conventionalLogs, { recursive: true });
  const configuredLog = path.join(customLogs, "CitizenFX_log_2026-01-01T000000.log");
  const fallbackLog = path.join(conventionalLogs, "CitizenFX_log_2026-01-02T000000.log");
  fs.writeFileSync(configuredLog, "configured");
  fs.writeFileSync(fallbackLog, "fallback");
  fs.writeFileSync(path.join(customLogs, "not-a-client.log"), "unrelated");
  try {
    fs.symlinkSync(fallbackLog, path.join(customLogs, "CitizenFX_log_2026-01-03T000000.log"));
  } catch {
    // Symlink creation can be unavailable on locked-down Windows runners.
  }
  assert.equal(findLatestClientLog({
    target: "legacy",
    configuredExecutable: path.join(customInstall, "FiveM.exe"),
    localAppData: path.join(root, "local"),
  }), configuredLog);
});

test("tails appended output, preserves UTF-8 boundaries, rotates, and bounds the line count", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, "FiveM");
  const logs = path.join(install, "FiveM.app", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const first = path.join(logs, "CitizenFX_log_2026-01-01T000000.log");
  fs.writeFileSync(first, "one\ntwo\npartial 🚗");
  const reader = new ClientConsoleReader();
  const options = { target: "legacy" as const, configuredExecutable: path.join(install, "FiveM.exe"), lines: 2 };
  assert.deepEqual(reader.read(options), { available: true, output: "two\npartial 🚗", target: "legacy" });
  fs.appendFileSync(first, " finished\nthree\n");
  assert.equal(reader.read(options).output, "partial 🚗 finished\nthree");

  const second = path.join(logs, "CitizenFX_log_2026-01-02T000000.log");
  fs.writeFileSync(second, "rotated\n");
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(second, future, future);
  assert.equal(reader.read(options).output, "rotated");
});

test("returns unavailable when the target has not produced a client log", () => {
  const reader = new ClientConsoleReader();
  assert.deepEqual(reader.read({ target: "redm", configuredExecutable: null }), {
    available: false,
    output: "",
    target: "redm",
  });
  assert.deepEqual(clientLogDirectoryGroups({ target: "redm", configuredExecutable: null }), []);
});
