import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { invalidateConsoleSourceIndex, resolveConsoleSourceLocation } from "./consoleSourceResolver";

function canonical(value: string): string {
  return fs.realpathSync(value);
}

function workspace(t: test.TestContext) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-console-source-"));
  const resources = path.join(profile, "resources");
  fs.mkdirSync(resources);
  const canonicalResources = canonical(resources);
  t.after(() => {
    invalidateConsoleSourceIndex(canonicalResources);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const addResource = (group: string, name: string, files: Record<string, string>) => {
    const root = path.join(resources, group, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "fxmanifest.lua"), "fx_version 'cerulean'", "utf8");
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, "utf8");
    }
    return root;
  };
  return { profile, resources, addResource };
}

test("resolves case-insensitive resources nested below category folders", async (t) => {
  const { profile, resources, addResource } = workspace(t);
  const resource = addResource("[core]", "qb-core", { "server/main.lua": "return true" });
  assert.deepEqual(await resolveConsoleSourceLocation(profile, resources, {
    kind: "resource",
    source: "server/main.lua",
    resourceName: "QB-CORE",
    line: 42,
    column: 7,
  }), {
    path: canonical(path.join(resource, "server", "main.lua")),
    line: 42,
    column: 7,
  });
});

test("resolves real loading-error and source-map relative paths inside a resource", async (t) => {
  const { profile, resources, addResource } = workspace(t);
  const resource = addResource("[system]", "yarn", {
    "yarn_builder.js": "throw new Error()",
    "server/index.ts": "throw new Error()",
  });
  const loading = await resolveConsoleSourceLocation(profile, resources, {
    kind: "relative", source: "yarn_builder.js", resourceName: "yarn", line: 81, column: 1,
  });
  assert.equal(loading.path, canonical(path.join(resource, "yarn_builder.js")));

  const sourceMap = await resolveConsoleSourceLocation(profile, resources, {
    kind: "relative", source: "../server/index.ts", resourceName: "yarn", line: 3, column: 1,
  });
  assert.equal(sourceMap.path, canonical(path.join(resource, "server", "index.ts")));
});

test("preserves a spaced nested resource path when a basename candidate also exists", async (t) => {
  const { profile, resources, addResource } = workspace(t);
  const resource = addResource("[local]", "demo", {
    "file.js": "root candidate",
    "server/my file.js": "nested candidate",
  });

  const location = await resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", resourceName: "demo", source: "server/my file.js", line: 12, column: 3,
  });
  assert.deepEqual(location, {
    path: canonical(path.join(resource, "server", "my file.js")),
    line: 12,
    column: 3,
  });
});

test("returns canonical on-disk casing for Windows source paths", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path identity is case-insensitive");
    return;
  }
  const { profile, resources, addResource } = workspace(t);
  const resource = addResource("[local]", "demo", { "Server/Main.lua": "return true" });
  const location = await resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", resourceName: "demo", source: "server/main.lua", line: 1, column: 1,
  });
  assert.equal(location.path, canonical(path.join(resource, "Server", "Main.lua")));
});

test("resolves only contained profile-relative and absolute files", async (t) => {
  const { profile, resources, addResource } = workspace(t);
  const resource = addResource("[local]", "demo", { "server/Main File.cs": "class Main {}" });
  const config = path.join(profile, "server.cfg");
  fs.writeFileSync(config, "ensure demo", "utf8");

  assert.equal((await resolveConsoleSourceLocation(profile, resources, {
    kind: "profile", source: "server.cfg", line: 2, column: 1,
  })).path, canonical(config));
  assert.equal((await resolveConsoleSourceLocation(profile, resources, {
    kind: "absolute", source: path.join(resource, "server", "Main File.cs"), line: 12, column: 4,
  })).path, canonical(path.join(resource, "server", "Main File.cs")));

  const outside = path.join(path.dirname(profile), `${path.basename(profile)}-outside.lua`);
  fs.writeFileSync(outside, "return false", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "absolute", source: outside, line: 1, column: 1,
  }), /outside the project folder/i);
});

test("rejects missing, duplicate, traversing, malformed, and non-file locations", async (t) => {
  const { profile, resources, addResource } = workspace(t);
  const first = addResource("[one]", "duplicate", { "server.lua": "return true" });
  addResource("[two]", "duplicate", { "server.lua": "return true" });
  addResource("[local]", "safe", { "server.lua": "return true" });
  fs.mkdirSync(path.join(first, "folder.lua"));

  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "server.lua", resourceName: "unknown", line: 1, column: 1,
  }), /not found/i);
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "server.lua", resourceName: "duplicate", line: 1, column: 1,
  }), /ambiguous/i);
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "../server.lua", resourceName: "safe", line: 1, column: 1,
  }), /leave its resource/i);
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "missing.lua", resourceName: "safe", line: 1, column: 1,
  }), /no longer exists/i);
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "folder.lua", resourceName: "duplicate", line: 1, column: 1,
  }), /ambiguous/i);
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "server.lua", resourceName: "safe", line: 0, column: 1,
  }), /positive integer/i);
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "server.exe", resourceName: "safe", line: 1, column: 1,
  }), /path is invalid/i);
});

test("indexes only through Cfx bracket categories and invalidates cached ambiguity", async (t) => {
  const { profile, resources, addResource } = workspace(t);
  const first = addResource("[one]", "cached", { "server.lua": "return true" });
  const hidden = path.join(resources, "ordinary-container", "nested");
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, "fxmanifest.lua"), "fx_version 'cerulean'", "utf8");
  fs.writeFileSync(path.join(hidden, "server.lua"), "return true", "utf8");

  assert.equal((await resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "server.lua", resourceName: "cached", line: 1, column: 1,
  })).path, canonical(path.join(first, "server.lua")));
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "server.lua", resourceName: "nested", line: 1, column: 1,
  }), /not found/i);

  // Cfx stops at every ordinary non-category directory and claims its name
  // before deciding whether the manifest is usable.
  const manifestlessDuplicate = path.join(resources, "[two]", "cached");
  fs.mkdirSync(manifestlessDuplicate, { recursive: true });
  fs.writeFileSync(path.join(manifestlessDuplicate, "server.lua"), "return true", "utf8");
  invalidateConsoleSourceIndex(canonical(resources));
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "server.lua", resourceName: "cached", line: 1, column: 1,
  }), /ambiguous/i);
});

test("rejects NTFS alternate data streams without rejecting an absolute drive path", async (t) => {
  const { profile, resources, addResource } = workspace(t);
  const resource = addResource("[local]", "safe", { "server.lua": "return true" });
  const config = path.join(profile, "server.cfg");
  fs.writeFileSync(config, "ensure safe", "utf8");

  for (const request of [
    { kind: "resource", source: "server.lua:payload.lua", resourceName: "safe", line: 1, column: 1 },
    { kind: "relative", source: "server.lua:payload.lua", resourceName: "safe", line: 1, column: 1 },
    { kind: "profile", source: "server.cfg:payload.lua", line: 1, column: 1 },
    { kind: "absolute", source: `${path.join(resource, "server.lua")}:payload.lua`, line: 1, column: 1 },
  ]) {
    await assert.rejects(resolveConsoleSourceLocation(profile, resources, request), /alternate data stream/i);
  }

  assert.equal((await resolveConsoleSourceLocation(profile, resources, {
    kind: "absolute", source: config, line: 1, column: 1,
  })).path, canonical(config));
});

test("rejects source files reached through a linked path", async (t) => {
  const { profile, resources, addResource } = workspace(t);
  const resource = addResource("[local]", "safe", {});
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-console-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "outside.lua"), "return false", "utf8");
  try {
    fs.symlinkSync(outside, path.join(resource, "linked"), "junction");
  } catch {
    t.skip("creating symbolic links requires Windows Developer Mode or elevation");
    return;
  }
  await assert.rejects(resolveConsoleSourceLocation(profile, resources, {
    kind: "resource", source: "linked/outside.lua", resourceName: "safe", line: 1, column: 1,
  }), /symbolic link|junction/i);
});
