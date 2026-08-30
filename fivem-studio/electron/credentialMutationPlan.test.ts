import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCredentialMutationPlan,
  type CredentialConnectionIdentity,
} from "./credentialMutationPlan";
import { NativeFileTransaction, NativeFileTransactionError } from "./nativeFileTransaction";

function identity(id: string, scope: string, storageName: string, requiresKey = true): CredentialConnectionIdentity {
  return { id, scope, storageName, requiresKey };
}

function fixture(overrides: Partial<Parameters<typeof buildCredentialMutationPlan>[0]> = {}) {
  const currentPath = (name: string) => path.resolve("credential-plan", "current", `${name}-key.bin`);
  const candidates = (name: string) => [
    currentPath(name),
    path.resolve("credential-plan", "former", `${name}-key.bin`),
  ];
  return {
    requestedConnectionIds: new Set(["account"]),
    previousConnections: [identity("account", "scope-a", "storage-a")],
    nextConnections: [identity("account", "scope-a", "storage-a")],
    updates: [],
    migration: { write: null, removals: [] },
    currentPath,
    candidates,
    pathIdentity: (candidate: string) => path.resolve(candidate).toLocaleLowerCase(),
    ...overrides,
  };
}

function paths(values: readonly { path: string }[]): string[] {
  return values.map((value) => value.path);
}

test("replacement writes the current scoped credential and retires historical copies", () => {
  const input = fixture({ updates: [{ connectionId: "account", data: Buffer.from("encrypted-new") }] });
  const plan = buildCredentialMutationPlan(input);

  assert.deepEqual(paths(plan.writes), [input.currentPath("storage-a")]);
  assert.deepEqual(Buffer.from(plan.writes[0].data).toString(), "encrypted-new");
  assert.deepEqual(plan.removals, [input.candidates("storage-a")[1]]);
});

test("clear, removal, and keyless transition retire every scoped copy", () => {
  const clearInput = fixture({ updates: [{ connectionId: "account", data: null }] });
  assert.deepEqual(buildCredentialMutationPlan(clearInput), {
    writes: [],
    removals: clearInput.candidates("storage-a"),
  });

  const removedInput = fixture({ requestedConnectionIds: new Set(), nextConnections: [] });
  assert.deepEqual(buildCredentialMutationPlan(removedInput).removals, removedInput.candidates("storage-a"));

  const keylessInput = fixture({
    nextConnections: [identity("account", "scope-a", "storage-a", false)],
  });
  assert.deepEqual(buildCredentialMutationPlan(keylessInput).removals, keylessInput.candidates("storage-a"));
});

test("missing versioned connection input never implies credential deletion", () => {
  const input = fixture({ requestedConnectionIds: null, nextConnections: [] });
  assert.deepEqual(buildCredentialMutationPlan(input), { writes: [], removals: [] });
});

test("endpoint edit retires the old scope while writing only the new scope", () => {
  const input = fixture({
    nextConnections: [identity("account", "scope-b", "storage-b")],
    updates: [{ connectionId: "account", data: Buffer.from("encrypted-b") }],
  });
  const plan = buildCredentialMutationPlan(input);

  assert.deepEqual(paths(plan.writes), [input.currentPath("storage-b")]);
  assert.deepEqual(plan.removals, [
    ...input.candidates("storage-a"),
    input.candidates("storage-b")[1],
  ]);
});

test("legacy migration and explicit changes compose without duplicate targets", () => {
  const source = path.resolve("credential-plan", "legacy", "provider-key.bin");
  const target = path.resolve("credential-plan", "current", "storage-a-key.bin");
  const input = fixture({
    migration: { write: { path: target, data: Buffer.from("encrypted-legacy") }, removals: [source, source] },
  });
  const plan = buildCredentialMutationPlan(input);

  assert.deepEqual(paths(plan.writes), [target]);
  assert.deepEqual(plan.removals, [source]);
  assert.throws(() => buildCredentialMutationPlan(fixture({
    updates: [{ connectionId: "missing", data: Buffer.from("encrypted") }],
  })), /unknown connection/);
});

test("planned endpoint migration rolls back as one config transaction", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qb-credential-plan-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const currentPath = (name: string) => path.join(directory, "current", `${name}-key.bin`);
  const formerPath = (name: string) => path.join(directory, "former", `${name}-key.bin`);
  const candidates = (name: string) => [currentPath(name), formerPath(name)];
  const oldCurrent = currentPath("storage-a");
  const oldFormer = formerPath("storage-a");
  const publicConfig = path.join(directory, "qb-studio.config.json");
  fs.mkdirSync(path.dirname(oldCurrent), { recursive: true });
  fs.mkdirSync(path.dirname(oldFormer), { recursive: true });
  fs.writeFileSync(oldCurrent, "encrypted-old-current");
  fs.writeFileSync(oldFormer, "encrypted-old-former");
  fs.writeFileSync(publicConfig, "old-config");

  const plan = buildCredentialMutationPlan({
    requestedConnectionIds: new Set(["account"]),
    previousConnections: [identity("account", "scope-a", "storage-a")],
    nextConnections: [identity("account", "scope-b", "storage-b")],
    updates: [{ connectionId: "account", data: Buffer.from("encrypted-new") }],
    migration: { write: null, removals: [] },
    currentPath,
    candidates,
    pathIdentity: (candidate) => path.resolve(candidate).toLocaleLowerCase(),
  });
  const transaction = new NativeFileTransaction({
    replaceFile(source, target) {
      if (target === publicConfig) throw Object.assign(new Error("config commit failed"), { code: "EIO" });
      fs.renameSync(source, target);
    },
  });
  for (const write of plan.writes) transaction.stageWrite(write.path, write.data);
  for (const removal of plan.removals) transaction.stageRemoval(removal);

  assert.throws(
    () => transaction.commit(publicConfig, "new-config"),
    (error: unknown) => error instanceof NativeFileTransactionError && /config commit failed/.test(error.message),
  );
  assert.equal(fs.readFileSync(oldCurrent, "utf8"), "encrypted-old-current");
  assert.equal(fs.readFileSync(oldFormer, "utf8"), "encrypted-old-former");
  assert.equal(fs.existsSync(currentPath("storage-b")), false);
  assert.equal(fs.readFileSync(publicConfig, "utf8"), "old-config");
});
