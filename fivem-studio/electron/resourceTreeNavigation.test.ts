import assert from "node:assert/strict";
import test from "node:test";

import { resourceTreeNavigationAction, type ResourceTreeNavigationItem } from "./resourceTreeNavigation";

const visible: ResourceTreeNavigationItem[] = [
  { path: "root", parentPath: null, isDirectory: true, expanded: true },
  { path: "root/a", parentPath: "root", isDirectory: true, expanded: true },
  { path: "root/a/file.lua", parentPath: "root/a", isDirectory: false, expanded: false },
  { path: "root/b", parentPath: "root", isDirectory: true, expanded: false },
];

test("resource tree moves through visible items in document order", () => {
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/a", "ArrowDown"), { type: "focus", path: "root/a/file.lua" });
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/b", "ArrowUp"), { type: "focus", path: "root/a/file.lua" });
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/a/file.lua", "Home"), { type: "focus", path: "root" });
  assert.deepEqual(resourceTreeNavigationAction(visible, "root", "End"), { type: "focus", path: "root/b" });
});

test("resource tree right and left arrows expand, enter children, collapse, and return to parents", () => {
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/b", "ArrowRight"), { type: "toggle", path: "root/b" });
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/a", "ArrowRight"), { type: "focus", path: "root/a/file.lua" });
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/a", "ArrowLeft"), { type: "toggle", path: "root/a" });
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/a/file.lua", "ArrowLeft"), { type: "focus", path: "root/a" });
  assert.deepEqual(resourceTreeNavigationAction(visible, "root", "ArrowLeft"), { type: "toggle", path: "root" });
});

test("resource tree activation remains distinct from expansion navigation", () => {
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/a/file.lua", "Enter"), { type: "activate", path: "root/a/file.lua" });
  assert.deepEqual(resourceTreeNavigationAction(visible, "root/a", " "), { type: "activate", path: "root/a" });
});
