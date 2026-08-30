import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertSafeBasename, resolveInsideRoot } from "./pathSafety";

test("resolveInsideRoot refuses lexical traversal and absolute paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-path-"));
  try {
    assert.throws(() => resolveInsideRoot(root, "../outside"));
    assert.throws(() => resolveInsideRoot(root, path.resolve(root, "..", "outside")));
    assert.equal(resolveInsideRoot(root, "resource/fxmanifest.lua"), path.join(root, "resource", "fxmanifest.lua"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveInsideRoot refuses a new file below a link ancestor", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-path-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fivem-studio-outside-"));
  try {
    try {
      fs.symlinkSync(outside, path.join(root, "link"), "junction");
    } catch {
      t.skip("creating a link requires privileges on this host");
      return;
    }
    assert.throws(() => resolveInsideRoot(root, "link/new-file.lua"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("assertSafeBasename rejects path components and Windows-invalid names", () => {
  assert.equal(assertSafeBasename("resource-name"), "resource-name");
  for (const value of ["", ".", "..", "a/b", "a\\b", "a:bad", "trailing.", "CON", "nul.txt", "CLOCK$", "LPT9.lua"]) {
    assert.throws(() => assertSafeBasename(value));
  }
});
