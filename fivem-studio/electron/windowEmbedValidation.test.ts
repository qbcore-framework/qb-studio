import assert from "node:assert/strict";
import test from "node:test";

import {
  getFreshCandidate,
  isCfxBootstrapProcessName,
  isCfxClientProcessName,
  isCfxGameRenderProcessName,
  matchesDiscoveredWindow,
  selectAutoAttachCandidate,
  type DiscoveredWindowCandidate,
} from "./windowEmbedValidation";

const candidate: DiscoveredWindowCandidate = {
  id: "opaque-id",
  hwndId: "12345",
  pid: 4321,
  processName: "GTA5_Enhanced.exe",
  expiresAt: 20_000,
};

test("only returns an unexpired discovered candidate", () => {
  const candidates = new Map([[candidate.id, candidate]]);
  assert.equal(getFreshCandidate(candidates, candidate.id, 20_000), candidate);
  assert.equal(getFreshCandidate(candidates, candidate.id, 20_001), null);
  assert.equal(getFreshCandidate(candidates, "not-discovered", 10_000), null);
});

test("requires the current PID and process identity to match the discovered window", () => {
  assert.equal(matchesDiscoveredWindow(candidate, { pid: 4321, processName: "gta5_enhanced.exe" }), true);
  assert.equal(matchesDiscoveredWindow(candidate, { pid: 9999, processName: "gta5_enhanced.exe" }), false);
  assert.equal(matchesDiscoveredWindow(candidate, { pid: 4321, processName: "FiveM.exe" }), false);
});

test("recognizes FiveM and RedM bootstrap and render processes", () => {
  for (const processName of ["FiveM.exe", "GTA5_Enhanced.exe", "RedM.exe", "RDR2.exe", "RDR2_b1491.exe"]) {
    assert.equal(isCfxClientProcessName(processName), true, processName);
  }
  assert.equal(isCfxClientProcessName("explorer.exe"), false);
  assert.equal(isCfxClientProcessName("My RedM Notes.exe"), false);
});

test("automatic capture prefers game render surfaces and falls back to the launcher", () => {
  assert.equal(isCfxBootstrapProcessName("FiveM.exe", "enhanced"), true);
  assert.equal(isCfxBootstrapProcessName("FiveM.exe", "redm"), false);
  assert.equal(isCfxBootstrapProcessName("RedM.exe", "redm"), true);
  assert.equal(isCfxGameRenderProcessName("FiveM.exe", "legacy"), false);
  assert.equal(isCfxGameRenderProcessName("FiveM_b3258_GTAProcess.exe", "legacy"), true);
  assert.equal(isCfxGameRenderProcessName("GTA5_Enhanced.exe", "enhanced"), true);
  assert.equal(isCfxGameRenderProcessName("RedM.exe", "redm"), false);
  assert.equal(isCfxGameRenderProcessName("RedM_b1491_GTAProcess.exe", "redm"), true);
  assert.equal(isCfxGameRenderProcessName("RDR2_b1491.exe", "redm"), true);
  assert.equal(isCfxGameRenderProcessName("RDR2.exe", "legacy"), false);

  const windows = [
    { processName: "FiveM.exe", id: "bootstrap" },
    { processName: "RDR2.exe", id: "wrong-game" },
    { processName: "GTA5_Enhanced.exe", id: "render" },
  ];
  assert.equal(selectAutoAttachCandidate(windows, "enhanced")?.id, "render");
  assert.equal(selectAutoAttachCandidate(windows, "redm")?.id, "wrong-game");
  assert.equal(selectAutoAttachCandidate(windows.slice(0, 1), "legacy")?.id, "bootstrap");
});
