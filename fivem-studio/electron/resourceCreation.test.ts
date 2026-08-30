import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readTextFileSnapshot } from "./fsTree";
import { parseManifestForm, REDM_MANIFEST_WARNING } from "./manifestModel";
import { createResourceDirectory, createResourceFile, createStarterResource } from "./resourceCreation";

const templateCatalogRoot = path.resolve(__dirname, "..", "resources", "resource-templates");

function relativeFiles(root: string): string[] {
  const files: string[] = [];
  const pending: Array<{ directory: string; relative: string }> = [{ directory: root, relative: "" }];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push({ directory: path.join(current.directory, entry.name), relative });
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files.sort();
}

function resourcesRoot(t: test.TestContext): string {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-create-resource-"));
  const resources = path.join(profile, "resources");
  fs.mkdirSync(resources);
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  return resources;
}

test("creates empty files and folders only below the chosen Resources folder", (t) => {
  const resources = resourcesRoot(t);
  const category = createResourceDirectory(resources, resources, "[local]");
  assert.deepEqual(category, { name: "[local]", path: path.join(resources, "[local]"), isDirectory: true });

  const folder = createResourceDirectory(resources, category.path, "helpers");
  const file = createResourceFile(resources, folder.path, "client.lua");
  assert.equal(file.path, path.join(resources, "[local]", "helpers", "client.lua"));
  assert.equal(fs.readFileSync(file.path, "utf8"), "");
  assert.equal(readTextFileSnapshot(file.path).content, "");

  assert.throws(() => createResourceFile(resources, folder.path, "client.lua"), /already exists/i);
  assert.equal(fs.readFileSync(file.path, "utf8"), "");
  assert.throws(() => createResourceDirectory(resources, category.path, "helpers"), /already exists/i);
  assert.throws(() => createResourceDirectory(resources, folder.path, "client.lua"), /already exists/i);
  assert.throws(() => createResourceFile(resources, category.path, "helpers"), /already exists/i);
  assert.throws(() => createResourceFile(resources, file.path, "nested.lua"), /ordinary folder/i);
  assert.throws(() => createResourceFile(resources, path.dirname(resources), "outside.lua"), /outside the project folder/i);
  assert.throws(() => createResourceFile(resources, resources, "../outside.lua"), /single valid filename/i);
  for (const reserved of [".git", ".DS_Store", "node_modules", ".QB-Studio-test", "CON.lua", "CLOCK$"]) {
    assert.throws(() => createResourceDirectory(resources, resources, reserved), /reserved|Windows/i, reserved);
  }
});

test("publishes a complete current Cfx starter resource atomically", (t) => {
  const resources = resourcesRoot(t);
  const category = createResourceDirectory(resources, resources, "[local]");
  const result = createStarterResource(resources, category.path, "my-resource");

  assert.equal(result.rootPath, path.join(category.path, "my-resource"));
  assert.deepEqual(result.files, ["fxmanifest.lua", "config.lua", "client.lua", "server.lua"]);
  assert.equal(result.fileCount, 4);
  assert.equal(result.game, "gta5");
  const manifest = fs.readFileSync(result.manifestPath, "utf8");
  assert.match(manifest, /^fx_version 'cerulean'$/m);
  assert.match(manifest, /^game 'gta5'$/m);
  assert.doesNotMatch(manifest, /^rdr3_warning\b/m);
  assert.match(manifest, /^shared_script 'config\.lua'$/m);
  assert.match(manifest, /^client_script 'client\.lua'$/m);
  assert.match(manifest, /^server_script 'server\.lua'$/m);
  const parsed = parseManifestForm(manifest);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.values.games, ["gta5"]);
    assert.deepEqual(parsed.values.shared_scripts, ["config.lua"]);
    assert.deepEqual(parsed.values.client_scripts, ["client.lua"]);
    assert.deepEqual(parsed.values.server_scripts, ["server.lua"]);
  }
  assert.doesNotMatch(manifest, /lua54|RegisterNetEvent|RegisterCommand|author\s/i);
  assert.match(fs.readFileSync(path.join(result.rootPath, "config.lua"), "utf8"), /Debug = false/);
  assert.match(fs.readFileSync(path.join(result.rootPath, "client.lua"), "utf8"), /client initialized/);
  assert.match(fs.readFileSync(path.join(result.rootPath, "server.lua"), "utf8"), /server initialized/);
  assert.equal(fs.readdirSync(category.path).some((name) => name.startsWith(".qb-studio-template-")), false);
});

test("creates every Lua and NUI starter for GTA5 and RedM with the exact manifest contract", (t) => {
  const resources = resourcesRoot(t);
  const category = createResourceDirectory(resources, resources, "[matrix]");
  const templates = ["lua", "static-nui", "react-nui", "vue-nui"] as const;
  const games = ["gta5", "rdr3"] as const;

  for (const template of templates) {
    for (const game of games) {
      const name = `${template}-${game}`;
      const result = createStarterResource(resources, category.path, name, game, template, templateCatalogRoot);
      const manifest = fs.readFileSync(result.manifestPath, "utf8");
      const parsed = parseManifestForm(manifest);
      assert.equal(parsed.ok, true, `${template}/${game} manifest should parse`);
      if (!parsed.ok) continue;

      assert.equal(result.template, template);
      assert.equal(result.game, game);
      assert.deepEqual(parsed.values.games, [game]);
      assert.deepEqual(parsed.values.shared_scripts, ["config.lua"]);
      assert.deepEqual(parsed.values.client_scripts, ["client.lua"]);
      assert.deepEqual(parsed.values.server_scripts, ["server.lua"]);
      assert.equal(parsed.values.rdr3_warning, game === "rdr3" ? REDM_MANIFEST_WARNING : "");
      assert.equal((manifest.match(/^rdr3_warning\b/gm) ?? []).length, game === "rdr3" ? 1 : 0);

      const expectedUiPage = template === "lua"
        ? ""
        : template === "static-nui"
          ? "html/index.html"
          : "html/dist/index.html";
      const expectedFiles = template === "lua"
        ? []
        : template === "static-nui"
          ? ["html/index.html", "html/style.css", "html/script.js"]
          : ["html/dist/**/*"];
      assert.equal(parsed.values.ui_page, expectedUiPage);
      assert.deepEqual(parsed.values.files, expectedFiles);

      const files = relativeFiles(result.rootPath);
      assert.deepEqual(files, [...result.files].sort());
      assert.equal(result.fileCount, files.length);
      assert.equal(files.some((file) => file.split("/").includes("node_modules")), false);
      if (template === "lua") {
        assert.deepEqual(files, ["client.lua", "config.lua", "fxmanifest.lua", "server.lua"]);
      } else if (template === "static-nui") {
        assert.deepEqual(files, [
          "client.lua",
          "config.lua",
          "fxmanifest.lua",
          "html/index.html",
          "html/script.js",
          "html/style.css",
          "server.lua",
        ]);
      } else {
        for (const required of [
          "README.md",
          "THIRD_PARTY_NOTICES.txt",
          "html/package.json",
          "html/package-lock.json",
          "html/vite.config.js",
          "html/index.html",
          "html/dist/index.html",
        ]) {
          assert.ok(files.includes(required), `${template} should include ${required}`);
        }
        assert.ok(files.some((file) => file.startsWith("html/src/")), `${template} should include editable source`);
        assert.ok(files.some((file) => /^html\/dist\/assets\/[^/]+\.js$/.test(file)), `${template} should include prebuilt JavaScript`);
        assert.ok(files.some((file) => /^html\/dist\/assets\/[^/]+\.css$/.test(file)), `${template} should include prebuilt CSS`);

        const packageJson = JSON.parse(fs.readFileSync(path.join(result.rootPath, "html", "package.json"), "utf8"));
        const packageLock = JSON.parse(fs.readFileSync(path.join(result.rootPath, "html", "package-lock.json"), "utf8"));
        assert.deepEqual(packageLock.packages?.[""]?.dependencies ?? {}, packageJson.dependencies ?? {});
        assert.deepEqual(packageLock.packages?.[""]?.devDependencies ?? {}, packageJson.devDependencies ?? {});
      }

      for (const file of files) {
        const content = fs.readFileSync(path.join(result.rootPath, ...file.split("/")), "utf8");
        assert.doesNotMatch(content, /__QB_[A-Z0-9_]*__/, `${template}/${game}/${file} has an unresolved placeholder`);
        assert.doesNotMatch(content, /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:)?\/\//i,
          `${template}/${game}/${file} has a remote script or stylesheet`);
      }

      if (template !== "lua" && template !== "static-nui") {
        const distRoot = path.join(result.rootPath, "html", "dist");
        const distIndex = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
        const assetReferences = [...distIndex.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
        assert.ok(assetReferences.length >= 2);
        for (const reference of assetReferences) {
          assert.match(reference, /^\.\/assets\//);
          assert.equal(fs.existsSync(path.resolve(distRoot, reference)), true, `${reference} should exist`);
        }
      }
    }
  }
});

test("static NUI callbacks remain allowed for valid resource names containing underscores", (t) => {
  const resources = resourcesRoot(t);
  const result = createStarterResource(
    resources,
    resources,
    "ui_with_underscores",
    "gta5",
    "static-nui",
    templateCatalogRoot,
  );
  const page = fs.readFileSync(path.join(result.rootPath, "html", "index.html"), "utf8");
  assert.match(page, /connect-src 'self' https:;/);
  assert.doesNotMatch(page, /connect-src[^;]*https:\/\/ui_with_underscores/i);
  assert.doesNotMatch(page, /__QB_RESOURCE_NAME__/);
});

test("rejects tampered template catalogs and cleans every staging directory atomically", (t) => {
  const resources = resourcesRoot(t);
  const category = createResourceDirectory(resources, resources, "[local]");
  const tamperedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-tampered-template-"));
  t.after(() => fs.rmSync(tamperedRoot, { recursive: true, force: true }));
  const assertRejected = (
    catalog: string,
    name: string,
    template: "static-nui" | "react-nui",
    expected: RegExp,
  ) => {
    assert.throws(
      () => createStarterResource(resources, category.path, name, "gta5", template, catalog),
      expected,
    );
    assert.equal(fs.existsSync(path.join(category.path, name)), false);
    assert.equal(fs.readdirSync(category.path).some((entry) => entry.startsWith(".qb-studio-template-")), false);
  };

  const incompleteCatalog = path.join(tamperedRoot, "incomplete");
  fs.mkdirSync(path.join(incompleteCatalog, "react-nui"), { recursive: true });
  assertRejected(incompleteCatalog, "failed-react", "react-nui", /missing required file/i);

  const linkedCatalog = path.join(tamperedRoot, "linked");
  const linkedTemplate = path.join(linkedCatalog, "static-nui");
  const linkedTarget = path.join(tamperedRoot, "linked-target");
  fs.mkdirSync(linkedTemplate, { recursive: true });
  fs.mkdirSync(linkedTarget);
  fs.symlinkSync(linkedTarget, path.join(linkedTemplate, "linked-assets"), "junction");
  assertRejected(linkedCatalog, "failed-linked", "static-nui", /symbolic link|junction/i);

  const deepCatalog = path.join(tamperedRoot, "deep");
  let deepDirectory = path.join(deepCatalog, "react-nui");
  fs.mkdirSync(deepDirectory, { recursive: true });
  for (let depth = 0; depth < 10; depth += 1) {
    deepDirectory = path.join(deepDirectory, `level-${depth}`);
    fs.mkdirSync(deepDirectory);
  }
  assertRejected(deepCatalog, "failed-deep", "react-nui", /directory depth/i);

  const oversizedCatalog = path.join(tamperedRoot, "oversized");
  const oversizedTemplate = path.join(oversizedCatalog, "static-nui");
  fs.mkdirSync(oversizedTemplate, { recursive: true });
  fs.writeFileSync(path.join(oversizedTemplate, "oversized.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
  assertRejected(oversizedCatalog, "failed-oversized", "static-nui", /supported size/i);

  assert.equal(createStarterResource(resources, category.path, "failed-react").name, "failed-react");
});

test("starter resources reject invalid names, collisions, traversal, and nesting inside resources", (t) => {
  const resources = resourcesRoot(t);
  const category = createResourceDirectory(resources, resources, "[local]");
  const existing = createStarterResource(resources, category.path, "existing");

  assert.throws(() => createStarterResource(resources, category.path, "existing"), /already exists/i);
  assert.throws(() => createStarterResource(resources, category.path, "bad resource"), /only letters/i);
  assert.throws(() => createStarterResource(resources, existing.rootPath, "nested"), /not inside another resource/i);
  assert.throws(() => createStarterResource(resources, path.dirname(resources), "outside"), /outside the project folder/i);
  const ordinaryFolder = createResourceDirectory(resources, resources, "ordinary-folder");
  assert.throws(() => createStarterResource(resources, ordinaryFolder.path, "nested"), /bracketed category/i);
  const nestedCategory = createResourceDirectory(resources, category.path, "[nested]");
  assert.equal(createStarterResource(resources, nestedCategory.path, "nested-category").name, "nested-category");
  fs.writeFileSync(path.join(nestedCategory.path, "fxmanifest.lua"), "fx_version 'cerulean'\n", "utf8");
  assert.equal(createStarterResource(resources, nestedCategory.path, "category-manifest-warning").name, "category-manifest-warning");
  assert.equal(createStarterResource(resources, resources, "root-resource").rootPath, path.join(resources, "root-resource"));
  for (const invalid of ["-leading", ".hidden", "with space", "résource", "x".repeat(129)]) {
    assert.throws(() => createStarterResource(resources, category.path, invalid), /resource names/i, invalid);
  }
});

test("starter resources target RedM and reject case-insensitive names across categories", (t) => {
  const resources = resourcesRoot(t);
  const first = createResourceDirectory(resources, resources, "[one]");
  const second = createResourceDirectory(resources, resources, "[two]");
  createStarterResource(resources, first.path, "shared-name");
  assert.throws(() => createStarterResource(resources, second.path, "SHARED-NAME"), /already exists elsewhere/i);

  const claimedWithoutManifest = path.join(resources, "manifestless-name");
  fs.mkdirSync(claimedWithoutManifest);
  assert.throws(() => createStarterResource(resources, second.path, "MANIFESTLESS-NAME"), /already exists elsewhere/i);

  const broken = path.join(first.path, "broken-manifest");
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, "fxmanifest.lua"), Buffer.from([0, 1, 2]));
  assert.equal(createStarterResource(resources, second.path, "valid-beside-broken").name, "valid-beside-broken");
  for (const reserved of ["txAdmin", "yarn", "webpack"]) {
    assert.throws(() => createStarterResource(resources, second.path, reserved), /reserved by the Cfx resource scanner/i);
  }

  const redm = createStarterResource(resources, second.path, "redm-resource", "rdr3");
  assert.equal(redm.game, "rdr3");
  const redmManifest = fs.readFileSync(redm.manifestPath, "utf8");
  assert.match(redmManifest, /^game 'rdr3'$/m);
  assert.match(
    redmManifest,
    /^rdr3_warning 'I acknowledge that this is a prerelease build of RedM, and I am aware my resources \*will\* become incompatible once RedM ships\.'$/m,
  );
});

test("resource entry creation refuses linked parent folders", (t) => {
  const resources = resourcesRoot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-create-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const linked = path.join(resources, "linked");
  try {
    fs.symlinkSync(outside, linked, "junction");
  } catch {
    t.skip("creating symbolic links requires Windows Developer Mode or elevation");
    return;
  }
  assert.throws(() => createResourceFile(resources, linked, "outside.lua"), /symbolic link|junction/i);
});
