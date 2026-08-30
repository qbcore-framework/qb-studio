import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { definitionPackNamesFor, resolveLuaDefinitionPackRoots } from "./luaDefinitionPacks";

test("definition packs keep FiveM and QBCore together, and RedM isolated", () => {
  assert.deepEqual(definitionPackNamesFor("legacy"), ["fivem", "qbcore"]);
  assert.deepEqual(definitionPackNamesFor("enhanced"), ["fivem", "qbcore"]);
  assert.deepEqual(definitionPackNamesFor("redm"), ["redm"]);
});

test("definition pack roots are resolved only from the app-owned library root", () => {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-definition-packs-"));
  try {
    for (const pack of ["fivem", "redm", "qbcore"]) fs.mkdirSync(path.join(libraryRoot, pack));

    assert.deepEqual(resolveLuaDefinitionPackRoots(libraryRoot, "legacy"), [
      path.join(libraryRoot, "fivem"),
      path.join(libraryRoot, "qbcore"),
    ]);
    assert.deepEqual(resolveLuaDefinitionPackRoots(libraryRoot, "enhanced"), [
      path.join(libraryRoot, "fivem"),
      path.join(libraryRoot, "qbcore"),
    ]);
    assert.deepEqual(resolveLuaDefinitionPackRoots(libraryRoot, "redm"), [path.join(libraryRoot, "redm")]);
  } finally {
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
});

test("definition pack resolution rejects a missing selected pack", () => {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-definition-packs-"));
  try {
    fs.mkdirSync(path.join(libraryRoot, "fivem"));
    assert.throws(() => resolveLuaDefinitionPackRoots(libraryRoot, "legacy"), /qbcore.*missing/i);
    assert.throws(() => resolveLuaDefinitionPackRoots(libraryRoot, "redm"), /redm.*missing/i);
  } finally {
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
});
