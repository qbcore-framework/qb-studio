import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertTxAdminDataPath,
  discoverTxAdminControlProfile,
  loadLocalServerConfig,
  ManagedRuntimeGeneration,
  parseLocalServerConfig,
  synchronizeTxAdminDataPath,
} from "./managedRuntime";

test("parses loopback endpoints and both supported RCON password forms", () => {
  assert.deepEqual(
    parseLocalServerConfig(`
      endpoint_add_tcp "127.0.0.1:30120"
      endpoint_add_udp "127.0.0.1:30121"
      rcon_password "old value"
      SET RCON_PASSWORD "local secret"
    `),
    { host: "127.0.0.1", port: 30121, rconPassword: "local secret" },
  );
});

test("normalizes standard wildcard binds to loopback RCON destinations", () => {
  assert.deepEqual(
    parseLocalServerConfig(`
      endpoint_add_tcp "0.0.0.0:30120"
      endpoint_add_udp "0.0.0.0:30120"
      set rcon_password "local secret"
    `),
    { host: "127.0.0.1", port: 30120, rconPassword: "local secret" },
  );
  assert.deepEqual(
    parseLocalServerConfig('endpoint_add_udp "[::]:30121"\nset rcon_password "ipv6 secret"'),
    { host: "::1", port: 30121, rconPassword: "ipv6 secret" },
  );
  assert.deepEqual(
    parseLocalServerConfig('endpoint_add_tcp "0.0.0.0:30120"\nendpoint_add_udp "[::]:30121"'),
    { host: "::1", port: 30121, rconPassword: "" },
  );
});

test("rejects missing and explicit non-loopback FXServer endpoints", () => {
  assert.throws(() => parseLocalServerConfig('rcon_password "x"'), /no endpoint_add/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_tcp "192.168.1.5:30120"'), /only accepts numeric loopback/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_tcp "8.8.8.8:30120"'), /only accepts numeric loopback/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_tcp "[2001:db8::1]:30120"'), /only accepts numeric loopback/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_tcp "localhost:30120"'), /only accepts numeric loopback/);
  assert.throws(() => parseLocalServerConfig('endpoint_add_tcp "127.attacker.example:30120"'), /only accepts numeric loopback/);
  assert.throws(
    () => parseLocalServerConfig('endpoint_add_udp "0.0.0.0:30120"\nendpoint_add_tcp "192.168.1.5:30120"'),
    /only accepts numeric loopback/,
  );
});

test("rejects client-replicated RCON passwords and preserves an explicit empty password", () => {
  assert.throws(
    () => parseLocalServerConfig('endpoint_add_udp "0.0.0.0:30120"\nsetr rcon_password "secret"'),
    /replicate the password to clients/,
  );
  assert.deepEqual(
    parseLocalServerConfig('endpoint_add_udp "0.0.0.0:30120"\nset rcon_password ""'),
    { host: "127.0.0.1", port: 30120, rconPassword: "" },
  );
});

test("recursively loads workspace-local config includes before enforcing local targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-config-"));
  try {
    fs.writeFileSync(path.join(root, "server.cfg"), 'endpoint_add_udp "127.0.0.1:30120"\nexec nested.cfg\n');
    fs.writeFileSync(path.join(root, "nested.cfg"), 'endpoint_add_tcp "192.168.1.5:30120"\n');
    assert.throws(() => parseLocalServerConfig(loadLocalServerConfig(root)), /only accepts numeric loopback/);

    fs.writeFileSync(path.join(root, "nested.cfg"), 'exec ../outside.cfg\n');
    assert.throws(() => loadLocalServerConfig(root), /outside the project folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recursive config loading rejects include cycles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-config-"));
  try {
    fs.writeFileSync(path.join(root, "server.cfg"), "exec nested.cfg\n");
    fs.writeFileSync(path.join(root, "nested.cfg"), "exec server.cfg\n");
    assert.throws(() => loadLocalServerConfig(root), /include cycle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recursive config loading preserves RCON override order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-config-"));
  try {
    fs.writeFileSync(
      path.join(root, "server.cfg"),
      'endpoint_add_udp "0.0.0.0:30120"\nset rcon_password "before"\nexec secrets.cfg\nset rcon_password "after"\n',
    );
    fs.writeFileSync(path.join(root, "secrets.cfg"), 'set rcon_password "included"\n');
    assert.equal(parseLocalServerConfig(loadLocalServerConfig(root)).rconPassword, "after");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovers a txAdmin control profile separately from its server-data workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-txdata-"));
  try {
    const workspace = path.join(root, "local-dev.base");
    const control = path.join(root, "default");
    fs.mkdirSync(workspace);
    fs.mkdirSync(control);
    fs.writeFileSync(
      path.join(control, "config.json"),
      JSON.stringify({ version: 2, server: { dataPath: `${workspace}${path.sep}` } }),
    );
    assert.equal(discoverTxAdminControlProfile(root, workspace), "default");

    const second = path.join(root, "second");
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, "config.json"), JSON.stringify({ server: { dataPath: workspace } }));
    assert.equal(discoverTxAdminControlProfile(root, workspace), null, "ambiguous control profiles disable console discovery");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomically synchronizes txAdmin's default dataPath to a selected Enhanced workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-txdata-sync-"));
  try {
    const workspaceA = path.join(root, "WorkspaceA.base");
    const workspaceB = path.join(root, "WorkspaceB.base");
    const control = path.join(root, "default");
    fs.mkdirSync(workspaceA);
    fs.mkdirSync(workspaceB);
    fs.mkdirSync(control);
    const configPath = path.join(control, "config.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        version: 2,
        server: { dataPath: `${workspaceB}${path.sep}`, quiet: false },
        playerDatabase: { enabled: true },
      }, null, 2)}\n`,
    );

    const synchronized = synchronizeTxAdminDataPath(root, workspaceA);
    assert.equal(synchronized.controlProfile, "default");
    assert.equal(synchronized.updated, true);
    assert.doesNotThrow(() => assertTxAdminDataPath(root, workspaceA));
    assert.throws(() => assertTxAdminDataPath(root, workspaceB), /different server-data workspace/);
    assert.equal(discoverTxAdminControlProfile(root, workspaceA), "default");
    assert.equal(discoverTxAdminControlProfile(root, workspaceB), null);

    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      server: { dataPath: string; quiet: boolean };
      playerDatabase: { enabled: boolean };
    };
    assert.equal(path.resolve(persisted.server.dataPath), path.resolve(workspaceA));
    assert.equal(persisted.server.quiet, false, "unrelated server settings are preserved");
    assert.equal(persisted.playerDatabase.enabled, true, "unrelated txAdmin settings are preserved");
    assert.equal(synchronizeTxAdminDataPath(root, workspaceA).updated, false, "a matching config is not rewritten");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to start through a missing, malformed, or linked txAdmin default config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-txdata-sync-invalid-"));
  try {
    const workspace = path.join(root, "Workspace.base");
    const control = path.join(root, "default");
    fs.mkdirSync(workspace);
    assert.throws(() => synchronizeTxAdminDataPath(root, workspace), /control profile is missing/);

    fs.mkdirSync(control);
    const configPath = path.join(control, "config.json");
    fs.writeFileSync(configPath, "not-json");
    assert.throws(() => synchronizeTxAdminDataPath(root, workspace), /not valid JSON/);

    fs.rmSync(configPath);
    const external = path.join(root, "external.json");
    fs.writeFileSync(external, JSON.stringify({ server: { dataPath: workspace } }));
    try {
      fs.symlinkSync(external, configPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        t.diagnostic("Creating file links is not permitted on this machine.");
        return;
      }
      throw error;
    }
    assert.throws(() => synchronizeTxAdminDataPath(root, workspace), /symbolic link|regular file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale managed-runtime launch cannot own a newer launch", () => {
  const generation = new ManagedRuntimeGeneration();
  const first = generation.start();
  generation.invalidate();
  const second = generation.start();
  assert.equal(generation.owns(first), false);
  assert.equal(generation.owns(second), true);
});
