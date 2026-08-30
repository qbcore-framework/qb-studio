import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  NativeFileTransaction,
  NativeFileTransactionError,
  nativeFileTransactionJournalPath,
  recoverNativeFileTransaction,
} from "./nativeFileTransaction";

function temporaryDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qb-native-file-transaction-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, { mode: 0o600 });
}

function injectedError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

test("commits fsynced same-directory credential writes before the public file", (t) => {
  const directory = temporaryDirectory(t);
  const firstCredential = path.join(directory, "first-key.bin");
  const removedCredential = path.join(directory, "removed-key.bin");
  const config = path.join(directory, "studio.config.json");
  const journal = nativeFileTransactionJournalPath(config);
  write(firstCredential, "old-first");
  write(removedCredential, "old-removed");
  write(config, "old-config");

  const replacements: string[] = [];
  const temporaryPaths: string[] = [];
  let syncCount = 0;
  const transaction = new NativeFileTransaction({
    openExclusive(filePath, mode) {
      temporaryPaths.push(filePath);
      return fs.openSync(filePath, "wx", mode);
    },
    sync(descriptor) {
      syncCount += 1;
      fs.fsyncSync(descriptor);
    },
    replaceFile(source, target) {
      replacements.push(target);
      fs.renameSync(source, target);
    },
  });

  transaction
    .stageWrite(firstCredential, Buffer.from("new-first"))
    .stageRemoval(removedCredential)
    .commit(config, "new-config");

  assert.equal(fs.readFileSync(firstCredential, "utf8"), "new-first");
  assert.equal(fs.existsSync(removedCredential), false);
  assert.equal(fs.readFileSync(config, "utf8"), "new-config");
  assert.deepEqual(replacements, [journal, firstCredential, config], "the journal lands first and public config remains the final data commit");
  assert.equal(syncCount, 4, "pending and armed journal states plus each written file are fsynced");
  assert.equal(fs.existsSync(journal), false, "the completed journal is removed");
  assert.ok(temporaryPaths.every((filePath) => path.dirname(filePath) === directory));
  assert.ok(temporaryPaths.every((filePath) => path.basename(filePath).endsWith(".tmp")));
});

test("snapshots every credential before applying the first mutation", (t) => {
  const directory = temporaryDirectory(t);
  const firstCredential = path.join(directory, "first-key.bin");
  const unreadableCredential = path.join(directory, "unreadable-key.bin");
  const config = path.join(directory, "studio.config.json");
  write(firstCredential, "old-first");
  write(unreadableCredential, "old-unreadable");
  write(config, "old-config");

  const transaction = new NativeFileTransaction({
    lstat(filePath) {
      if (filePath === unreadableCredential) throw injectedError("EACCES", "snapshot denied");
      return fs.lstatSync(filePath);
    },
  });
  transaction.stageWrite(firstCredential, "new-first").stageRemoval(unreadableCredential);

  assert.throws(
    () => transaction.commit(config, "new-config"),
    (error: unknown) => error instanceof NativeFileTransactionError && /snapshot denied/.test(error.message),
  );
  assert.equal(fs.readFileSync(firstCredential, "utf8"), "old-first");
  assert.equal(fs.readFileSync(unreadableCredential, "utf8"), "old-unreadable");
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
});

test("rolls back earlier writes and removals when a later credential write fails", (t) => {
  const directory = temporaryDirectory(t);
  const firstCredential = path.join(directory, "first-key.bin");
  const removedCredential = path.join(directory, "removed-key.bin");
  const failingCredential = path.join(directory, "failing-key.bin");
  const config = path.join(directory, "studio.config.json");
  write(firstCredential, "old-first");
  write(removedCredential, "old-removed");
  write(config, "old-config");

  const transaction = new NativeFileTransaction({
    replaceFile(source, target) {
      if (target === failingCredential) throw injectedError("EIO", "credential replace failed");
      fs.renameSync(source, target);
    },
  });
  transaction
    .stageWrite(firstCredential, "new-first")
    .stageRemoval(removedCredential)
    .stageWrite(failingCredential, "new-failing");

  assert.throws(
    () => transaction.commit(config, "new-config"),
    (error: unknown) => error instanceof NativeFileTransactionError &&
      /credential replace failed/.test(error.message) && error.rollbackFailures.length === 0,
  );
  assert.equal(fs.readFileSync(firstCredential, "utf8"), "old-first");
  assert.equal(fs.readFileSync(removedCredential, "utf8"), "old-removed");
  assert.equal(fs.existsSync(failingCredential), false);
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  assert.equal(fs.existsSync(nativeFileTransactionJournalPath(config)), false);
});

test("rolls credentials back when the final public config commit fails", (t) => {
  const directory = temporaryDirectory(t);
  const firstCredential = path.join(directory, "first-key.bin");
  const removedCredential = path.join(directory, "removed-key.bin");
  const config = path.join(directory, "studio.config.json");
  write(firstCredential, "old-first");
  write(removedCredential, "old-removed");
  write(config, "old-config");

  const transaction = new NativeFileTransaction({
    replaceFile(source, target) {
      if (target === config) throw injectedError("EIO", "config replace failed");
      fs.renameSync(source, target);
    },
  });
  transaction.stageWrite(firstCredential, "new-first").stageRemoval(removedCredential);

  assert.throws(
    () => transaction.commit(config, "new-config"),
    (error: unknown) => error instanceof NativeFileTransactionError &&
      /config replace failed/.test(error.message) && error.rollbackFailures.length === 0,
  );
  assert.equal(fs.readFileSync(firstCredential, "utf8"), "old-first");
  assert.equal(fs.readFileSync(removedCredential, "utf8"), "old-removed");
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  assert.equal(fs.existsSync(nativeFileTransactionJournalPath(config)), false);
});

test("reports rollback failures without hiding the original commit failure", (t) => {
  const directory = temporaryDirectory(t);
  const credential = path.join(directory, "key.bin");
  const config = path.join(directory, "studio.config.json");
  write(credential, "old-key");
  write(config, "old-config");
  let credentialReplacements = 0;

  const transaction = new NativeFileTransaction({
    replaceFile(source, target) {
      if (target === config) throw injectedError("EIO", "config replace failed");
      if (target === credential && ++credentialReplacements === 2) {
        throw injectedError("EACCES", "credential restore denied");
      }
      fs.renameSync(source, target);
    },
  });
  transaction.stageWrite(credential, "new-key");

  let failure: unknown;
  try {
    transaction.commit(config, "new-config");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof NativeFileTransactionError);
  assert.match(failure.message, /config replace failed/);
  assert.match(failure.message, /credential restore denied/);
  assert.deepEqual(
    failure.rollbackFailures.map(({ path: failedPath, operation }) => ({ failedPath, operation })),
    [{ failedPath: credential, operation: "restore" }],
  );
  assert.equal(fs.readFileSync(credential, "utf8"), "new-key", "failed rollback leaves the landed state observable");
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  assert.equal(fs.existsSync(nativeFileTransactionJournalPath(config)), true, "redo is retained when rollback cannot finish");

  assert.equal(recoverNativeFileTransaction(config, {
    isPrivatePathAllowed: (candidate) => path.dirname(candidate) === directory,
  }), "recovered");
  assert.equal(fs.readFileSync(credential, "utf8"), "new-key");
  assert.equal(fs.readFileSync(config, "utf8"), "new-config");
  assert.equal(fs.existsSync(nativeFileTransactionJournalPath(config)), false);
});

test("surfaces credential deletion errors and leaves the public config uncommitted", (t) => {
  const directory = temporaryDirectory(t);
  const credential = path.join(directory, "key.bin");
  const config = path.join(directory, "studio.config.json");
  write(credential, "old-key");
  write(config, "old-config");

  const transaction = new NativeFileTransaction({
    removeFile(filePath) {
      if (filePath === credential) throw injectedError("EACCES", "credential deletion denied");
      fs.unlinkSync(filePath);
    },
  });
  transaction.stageRemoval(credential);

  assert.throws(
    () => transaction.commit(config, "new-config"),
    (error: unknown) => error instanceof NativeFileTransactionError &&
      /credential deletion denied/.test(error.message) && error.rollbackFailures.length === 0,
  );
  assert.equal(fs.readFileSync(credential, "utf8"), "old-key");
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  assert.equal(fs.existsSync(nativeFileTransactionJournalPath(config)), false);
});

test("rejects duplicate targets, including use of a staged target as the public file", (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, "same.bin");

  const duplicate = new NativeFileTransaction().stageWrite(target, "one");
  assert.throws(() => duplicate.stageRemoval(target), /staged only once/);

  const publicCollision = new NativeFileTransaction().stageWrite(target, "private");
  assert.throws(() => publicCollision.commit(target, "public"), /cannot also be a staged/);
});

test("retains redo instead of rolling credentials back after the public rename lands", (t) => {
  const directory = temporaryDirectory(t);
  const credential = path.join(directory, "key.bin");
  const config = path.join(directory, "studio.config.json");
  const journal = nativeFileTransactionJournalPath(config);
  write(credential, "old-key");
  write(config, "old-config");
  let directorySyncs = 0;

  const transaction = new NativeFileTransaction({
    syncDirectory() {
      directorySyncs += 1;
      // journal rename, credential rename, then public-config rename
      if (directorySyncs === 3) throw injectedError("EIO", "public directory fsync failed");
    },
  });
  transaction.stageWrite(credential, "new-key");

  assert.throws(
    () => transaction.commit(config, "new-config"),
    (error: unknown) => error instanceof NativeFileTransactionError && /public directory fsync failed/.test(error.message),
  );
  assert.equal(fs.readFileSync(credential, "utf8"), "new-key", "private state must not be rolled back after public rename");
  assert.equal(fs.readFileSync(config, "utf8"), "new-config");
  assert.equal(fs.existsSync(journal), true, "redo remains until all durability steps can be repeated");

  assert.equal(recoverNativeFileTransaction(config, {
    isPrivatePathAllowed: (candidate) => path.dirname(candidate) === directory,
  }), "recovered");
  assert.equal(fs.readFileSync(credential, "utf8"), "new-key");
  assert.equal(fs.readFileSync(config, "utf8"), "new-config");
  assert.equal(fs.existsSync(journal), false);
});

test("a post-journal-rename directory fsync failure cannot arm redo or block retry", (t) => {
  const directory = temporaryDirectory(t);
  const credential = path.join(directory, "key.bin");
  const config = path.join(directory, "studio.config.json");
  const journal = nativeFileTransactionJournalPath(config);
  write(credential, "old-key");
  write(config, "old-config");
  let directorySyncs = 0;

  const transaction = new NativeFileTransaction({
    syncDirectory() {
      directorySyncs += 1;
      if (directorySyncs === 1) throw injectedError("EIO", "pending journal directory fsync failed");
    },
  });
  transaction.stageWrite(credential, "new-key");
  assert.throws(() => transaction.commit(config, "new-config"), /pending journal directory fsync failed/);
  assert.equal(fs.readFileSync(credential, "utf8"), "old-key");
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  assert.equal(fs.existsSync(journal), false, "the landed but unarmed journal is cleaned for immediate retry");
  assert.equal(recoverNativeFileTransaction(config, {
    isPrivatePathAllowed: (candidate) => path.dirname(candidate) === directory,
  }), "none");

  new NativeFileTransaction()
    .stageWrite(credential, "retry-key")
    .commit(config, "retry-config");
  assert.equal(fs.readFileSync(credential, "utf8"), "retry-key");
  assert.equal(fs.readFileSync(config, "utf8"), "retry-config");
});

test("restart discards a durable aborted marker left after a completed rollback", (t) => {
  const directory = temporaryDirectory(t);
  const credential = path.join(directory, "key.bin");
  const config = path.join(directory, "studio.config.json");
  const journal = nativeFileTransactionJournalPath(config);
  write(credential, "old-key");
  write(config, "old-config");
  let directorySyncs = 0;

  const transaction = new NativeFileTransaction({
    replaceFile(source, target) {
      if (target === config) throw injectedError("EIO", "config replace failed");
      fs.renameSync(source, target);
    },
    syncDirectory() {
      directorySyncs += 1;
      // journal, credential, rollback restore, then aborted-marker rename
      if (directorySyncs === 4) throw injectedError("EIO", "aborted marker directory fsync failed");
    },
  });
  transaction.stageWrite(credential, "new-key");
  assert.throws(() => transaction.commit(config, "new-config"), /config replace failed/);
  assert.equal(fs.readFileSync(credential, "utf8"), "old-key");
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  assert.equal(fs.existsSync(journal), true);

  assert.equal(recoverNativeFileTransaction(config, {
    isPrivatePathAllowed: (candidate) => path.dirname(candidate) === directory,
  }), "discarded");
  assert.equal(fs.readFileSync(credential, "utf8"), "old-key");
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  assert.equal(fs.existsSync(journal), false);
});

const CRASH_EXIT_CODE = 86;

function runCrashFixture(directory: string, cut: string): ReturnType<typeof spawnSync> {
  const modulePath = path.join(__dirname, "nativeFileTransaction.js");
  const script = String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const api = require(process.argv[1]);
    const directory = process.argv[2];
    const cut = process.argv[3];
    const first = path.join(directory, "first-key.bin");
    const removed = path.join(directory, "removed-key.bin");
    const second = path.join(directory, "second-key.bin");
    const config = path.join(directory, "studio.config.json");
    const journal = api.nativeFileTransactionJournalPath(config);
    let fileSyncs = 0;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(first, "old-first", { mode: 0o600 });
    fs.writeFileSync(removed, "old-removed", { mode: 0o600 });
    fs.writeFileSync(config, "old-config", { mode: 0o600 });
    const transaction = new api.NativeFileTransaction({
      replaceFile(source, target) {
        fs.renameSync(source, target);
        if ((cut === "journal" && target === journal) ||
            (cut === "first-write" && target === first) ||
            (cut === "second-write" && target === second) ||
            (cut === "public" && target === config)) process.exit(${CRASH_EXIT_CODE});
      },
      removeFile(target) {
        fs.unlinkSync(target);
        if ((cut === "removal" && target === removed) ||
            (cut === "cleanup" && target === journal)) process.exit(${CRASH_EXIT_CODE});
      },
      sync(descriptor) {
        fs.fsyncSync(descriptor);
        fileSyncs += 1;
        if (cut === "armed" && fileSyncs === 2) process.exit(${CRASH_EXIT_CODE});
      },
    });
    transaction
      .stageWrite(first, Buffer.from("new-first"), { mode: 0o600 })
      .stageRemoval(removed)
      .stageWrite(second, Buffer.from("new-second"), { mode: 0o600 })
      .commit(config, "new-config", { mode: 0o600 });
    process.exit(0);
  `;
  return spawnSync(process.execPath, ["-e", script, modulePath, directory, cut], { encoding: "utf8" });
}

test("restart recovery finishes every hard-crash cut point and cleans the journal", (t) => {
  const root = temporaryDirectory(t);
  for (const cut of ["journal", "armed", "first-write", "removal", "second-write", "public", "cleanup"]) {
    const directory = path.join(root, cut);
    const result = runCrashFixture(directory, cut);
    assert.equal(result.status, CRASH_EXIT_CODE, `${cut}: ${result.stderr}`);
    const first = path.join(directory, "first-key.bin");
    const removed = path.join(directory, "removed-key.bin");
    const second = path.join(directory, "second-key.bin");
    const config = path.join(directory, "studio.config.json");
    const recovery = recoverNativeFileTransaction(config, {
      isPrivatePathAllowed: (candidate) => path.dirname(candidate) === directory,
    });
    assert.equal(recovery, cut === "cleanup" ? "none" : cut === "journal" ? "discarded" : "recovered", cut);
    assert.equal(fs.readFileSync(first, "utf8"), cut === "journal" ? "old-first" : "new-first", cut);
    assert.equal(fs.existsSync(removed), cut === "journal", cut);
    assert.equal(fs.existsSync(second), cut !== "journal", cut);
    if (cut !== "journal") assert.equal(fs.readFileSync(second, "utf8"), "new-second", cut);
    assert.equal(fs.readFileSync(config, "utf8"), cut === "journal" ? "old-config" : "new-config", cut);
    assert.equal(fs.existsSync(nativeFileTransactionJournalPath(config)), false, cut);
  }
});

test("journal is owner-only and stores staged encrypted bytes without a plaintext rendering", (t) => {
  const directory = temporaryDirectory(t);
  const result = runCrashFixture(directory, "journal");
  assert.equal(result.status, CRASH_EXIT_CODE, String(result.stderr));
  const config = path.join(directory, "studio.config.json");
  const journal = nativeFileTransactionJournalPath(config);
  const raw = fs.readFileSync(journal, "utf8");
  assert.doesNotMatch(raw, /new-first|new-second/, "opaque encrypted bytes are serialized as bounded base64");
  const parsed = JSON.parse(raw) as { mutations: Array<{ kind: string; data?: string }> };
  assert.equal(Buffer.from(parsed.mutations[0].data!, "base64").toString("utf8"), "new-first");
  if (process.platform !== "win32") assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
  recoverNativeFileTransaction(config, {
    isPrivatePathAllowed: (candidate) => path.dirname(candidate) === directory,
  });
  assert.equal(fs.existsSync(journal), false);
});

test("corrupt and out-of-scope journals never mutate files or get discarded", (t) => {
  const root = temporaryDirectory(t);
  for (const scenario of ["checksum", "path-policy"] as const) {
    const directory = path.join(root, scenario);
    const result = runCrashFixture(directory, "journal");
    assert.equal(result.status, CRASH_EXIT_CODE, String(result.stderr));
    const first = path.join(directory, "first-key.bin");
    const removed = path.join(directory, "removed-key.bin");
    const config = path.join(directory, "studio.config.json");
    const journal = nativeFileTransactionJournalPath(config);
    if (scenario === "checksum") {
      const document = JSON.parse(fs.readFileSync(journal, "utf8")) as { checksum: string };
      document.checksum = `${document.checksum[0] === "0" ? "1" : "0"}${document.checksum.slice(1)}`;
      fs.writeFileSync(journal, JSON.stringify(document), { mode: 0o600 });
    }
    assert.throws(
      () => recoverNativeFileTransaction(config, {
        isPrivatePathAllowed: scenario === "path-policy" ? () => false : () => true,
      }),
      /recovery refused/i,
      scenario,
    );
    assert.equal(fs.readFileSync(first, "utf8"), "old-first", scenario);
    assert.equal(fs.readFileSync(removed, "utf8"), "old-removed", scenario);
    assert.equal(fs.readFileSync(config, "utf8"), "old-config", scenario);
    assert.equal(fs.existsSync(journal), true, scenario);
  }
});

test("oversized recovery input is rejected before any mutation", (t) => {
  const directory = temporaryDirectory(t);
  const config = path.join(directory, "studio.config.json");
  const journal = nativeFileTransactionJournalPath(config);
  write(config, "old-config");
  fs.writeFileSync(journal, Buffer.alloc(4 * 1024 * 1024 + 1, 0x41), { mode: 0o600 });
  assert.throws(
    () => recoverNativeFileTransaction(config, { isPrivatePathAllowed: () => true }),
    /invalid journal/i,
  );
  assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  assert.equal(fs.existsSync(journal), true);
});
