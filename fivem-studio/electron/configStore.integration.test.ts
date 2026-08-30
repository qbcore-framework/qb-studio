import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentConnection } from "./configStore";

type NodeModuleLoader = {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};

let userDataPath = "";
let appDataPath = "";
const encryptedValues: string[] = [];
const decryptedValues: string[] = [];
const ENCRYPTED_PREFIX = Buffer.from("qb-studio-test-sealed:", "utf8");

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value: string): Buffer {
    encryptedValues.push(value);
    const encoded = Buffer.from(value, "utf8");
    for (let index = 0; index < encoded.length; index += 1) encoded[index] ^= 0xa5;
    return Buffer.concat([ENCRYPTED_PREFIX, encoded]);
  },
  decryptString(value: Buffer): string {
    assert.deepEqual(value.subarray(0, ENCRYPTED_PREFIX.length), ENCRYPTED_PREFIX);
    const decoded = Buffer.from(value.subarray(ENCRYPTED_PREFIX.length));
    for (let index = 0; index < decoded.length; index += 1) decoded[index] ^= 0xa5;
    const plaintext = decoded.toString("utf8");
    decryptedValues.push(plaintext);
    return plaintext;
  },
};

// Node's test process is not an Electron main process. Intercept just this
// module's Electron import so the real config-store composition can run with
// deterministic app directories and safeStorage semantics.
const moduleLoader = require("node:module") as NodeModuleLoader;
const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithFakeElectron(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath(name: string): string {
          if (name === "userData") return userDataPath;
          if (name === "appData") return appDataPath;
          throw new Error(`Unexpected Electron app path request: ${name}`);
        },
      },
      safeStorage: fakeSafeStorage,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let configStore: typeof import("./configStore");
try {
  configStore = require("./configStore") as typeof import("./configStore");
} finally {
  moduleLoader._load = originalLoad;
}

function createSandbox(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-config-store-"));
  userDataPath = path.join(root, "current-product");
  appDataPath = path.join(root, "app-data");
  encryptedValues.length = 0;
  decryptedValues.length = 0;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function connection(
  id: string,
  endpoint: string,
): AgentConnection {
  return {
    id,
    label: `Connection ${id}`,
    provider: "openai",
    baseUrl: endpoint,
    models: ["test-model"],
    requiresKey: true,
  };
}

function config(
  connections: AgentConnection[],
): unknown {
  return {
    agent: {
      schemaVersion: 1,
      connections,
      active: { connectionId: connections[0].id, model: connections[0].models[0] },
      credentialRevision: 0,
    },
  };
}

function credentialFile(candidate: AgentConnection): string {
  return path.join(
    userDataPath,
    `${configStore.connectionCredentialStorageName(candidate)}-key.bin`,
  );
}

test("connection credentials replace, read, and clear independently through the real config store", (t) => {
  createSandbox(t);
  const first = connection("first-account", "https://first.example.com/v1");
  const second = connection("second-account", "https://second.example.com/v1");
  const requested = config([first, second]);

  const saved = configStore.saveConfigWithConnectionKeys(requested, [
    { connectionId: first.id, key: "first-secret-v1" },
    { connectionId: second.id, key: "second-secret" },
  ]);

  assert.deepEqual(saved.agent.connections, [first, second]);
  assert.equal(configStore.loadConnectionKey(first.id), "first-secret-v1");
  assert.equal(configStore.loadConnectionKey(second.id), "second-secret");
  assert.deepEqual(encryptedValues, ["first-secret-v1", "second-secret"]);
  assert.deepEqual(decryptedValues, ["first-secret-v1", "second-secret"]);
  assert.equal(fs.readFileSync(path.join(userDataPath, "qb-studio.config.json"), "utf8").includes("secret"), false);
  assert.equal(fs.readFileSync(credentialFile(first)).includes(Buffer.from("first-secret-v1")), false);

  configStore.saveConfigWithConnectionKeys(requested, [
    { connectionId: first.id, key: "first-secret-v2" },
  ]);
  assert.equal(configStore.loadConnectionKey(first.id), "first-secret-v2");
  assert.equal(configStore.loadConnectionKey(second.id), "second-secret", "replacing one account must not alter another");

  configStore.saveConfigWithConnectionKeys(requested, [
    { connectionId: first.id, key: "" },
  ]);
  assert.equal(fs.existsSync(credentialFile(first)), false);
  assert.equal(configStore.loadConnectionKey(first.id), "");
  assert.equal(configStore.loadConnectionKey(second.id), "second-secret");
});

test("endpoint edits and connection deletion retire the previous scoped credentials", (t) => {
  createSandbox(t);
  const edited = connection("edited-account", "https://old.example.com/v1");
  const deleted = connection("deleted-account", "https://delete.example.com/v1");
  configStore.saveConfigWithConnectionKeys(config([edited, deleted]), [
    { connectionId: edited.id, key: "old-endpoint-secret" },
    { connectionId: deleted.id, key: "deleted-account-secret" },
  ]);
  const oldEndpointCredential = credentialFile(edited);
  const deletedCredential = credentialFile(deleted);
  assert.equal(fs.existsSync(oldEndpointCredential), true);
  assert.equal(fs.existsSync(deletedCredential), true);

  const changed = { ...edited, baseUrl: "https://new.example.com/v1" };
  configStore.saveConfigWithConnectionKeys(config([changed, deleted]), []);
  assert.equal(fs.existsSync(oldEndpointCredential), false, "an endpoint edit must retire the old authentication scope");
  assert.equal(configStore.loadConnectionKey(changed.id), "", "the old endpoint key must not follow the connection id");
  assert.equal(configStore.loadConnectionKey(deleted.id), "deleted-account-secret");

  configStore.saveConfigWithConnectionKeys(config([changed]), []);
  assert.equal(fs.existsSync(deletedCredential), false, "deleting a connection must retire its scoped key");
  assert.throws(
    () => configStore.loadConnectionKey(deleted.id),
    /not configured/,
  );
});

test("flat-schema migration preserves keyed local/custom endpoints and keyless custom endpoints", (t) => {
  createSandbox(t);
  const authenticatedLocalUrl = "http://127.0.0.1:12345/v1";
  const localLegacyName = configStore.providerCredentialStorageNames(authenticatedLocalUrl).current;
  const legacyConfigPath = path.join(userDataPath, "qb-studio.config.json");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(legacyConfigPath, JSON.stringify({
    agentProvider: "openai",
    openaiBaseUrl: authenticatedLocalUrl,
    openaiModel: "local-model",
  }));
  fs.writeFileSync(
    path.join(userDataPath, `${localLegacyName}-key.bin`),
    fakeSafeStorage.encryptString("local-auth-secret"),
  );

  const migratedLocal = configStore.loadConfig();
  assert.equal(migratedLocal.agent.connections[0].requiresKey, true);
  assert.equal(configStore.loadConnectionKey(migratedLocal.agent.connections[0].id), "local-auth-secret");
  configStore.saveConfigWithConnectionKeys(migratedLocal, []);
  assert.equal(configStore.loadConnectionKey(migratedLocal.agent.connections[0].id), "local-auth-secret");

  createSandbox(t);
  const authenticatedCustomUrl = "https://authenticated-custom.example/v1";
  const customLegacyName = configStore.providerCredentialStorageNames(authenticatedCustomUrl).current;
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, "qb-studio.config.json"), JSON.stringify({
    agentProvider: "openai",
    openaiBaseUrl: authenticatedCustomUrl,
    openaiModel: "custom-model",
  }));
  fs.writeFileSync(
    path.join(userDataPath, `${customLegacyName}-key.bin`),
    fakeSafeStorage.encryptString("custom-auth-secret"),
  );
  const migratedCustom = configStore.loadConfig();
  assert.equal(migratedCustom.agent.connections[0].requiresKey, true);
  assert.equal(configStore.loadConnectionKey(migratedCustom.agent.connections[0].id), "custom-auth-secret");

  createSandbox(t);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, "qb-studio.config.json"), JSON.stringify({
    agentProvider: "openai",
    openaiBaseUrl: "https://keyless-custom.example/v1",
    openaiModel: "custom-model",
  }));
  const migratedKeyless = configStore.loadConfig();
  assert.equal(migratedKeyless.agent.connections[0].requiresKey, false);
  assert.equal(configStore.loadConnectionKey(migratedKeyless.agent.connections[0].id), "");
});
