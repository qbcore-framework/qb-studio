import assert from "node:assert/strict";
import test from "node:test";

import {
  agentPromptWorkspaceScope,
  consumeAgentPromptEnvelope,
  decideAgentAutoSubmit,
  decideAgentPromptDispatch,
  isAgentPromptForWorkspace,
  isUnconsumedAgentPrompt,
} from "./agentPromptDecision";

test("prompt ids are consumed once and cannot move backward", () => {
  assert.equal(isUnconsumedAgentPrompt(0, 1), true);
  assert.equal(isUnconsumedAgentPrompt(1, 1), false);
  assert.equal(isUnconsumedAgentPrompt(2, 1), false);
  assert.equal(isUnconsumedAgentPrompt(2, 3), true);
  const first = { id: 3, text: "first", mode: "submit" as const, workspaceScope: "workspace-a" };
  const newer = { id: 4, text: "newer", mode: "submit" as const, workspaceScope: "workspace-a" };
  assert.equal(consumeAgentPromptEnvelope(first, 3), null);
  assert.equal(consumeAgentPromptEnvelope(newer, 3), newer);
});

test("queued prompts remain bound to the workspace that created them", () => {
  const originalScope = agentPromptWorkspaceScope("C:\\txData", "QB-Core");
  const nextScope = agentPromptWorkspaceScope("C:\\txData", "RedM");
  const prompt = { id: 7, text: "fix it", mode: "submit" as const, workspaceScope: originalScope };
  assert.equal(isAgentPromptForWorkspace(prompt, originalScope), true);
  assert.equal(isAgentPromptForWorkspace(prompt, nextScope), false);
  assert.equal(decideAgentPromptDispatch({
    prompt,
    workspaceScope: originalScope,
    ready: null,
    busy: false,
    sendLocked: false,
  }), "pending");
  assert.equal(decideAgentPromptDispatch({
    prompt,
    workspaceScope: nextScope,
    ready: true,
    busy: false,
    sendLocked: false,
  }), "workspace-mismatch");
  assert.notEqual(agentPromptWorkspaceScope("a|b", "c"), agentPromptWorkspaceScope("a", "b|c"));
});

test("automatic agent prompts submit only when configured and idle", () => {
  assert.equal(decideAgentAutoSubmit({ text: "fix it", ready: true, busy: false, sendLocked: false }), "send");
  assert.equal(decideAgentAutoSubmit({ text: "fix it", ready: true, busy: true, sendLocked: false }), "busy");
  assert.equal(decideAgentAutoSubmit({ text: "fix it", ready: true, busy: false, sendLocked: true }), "busy");
  assert.equal(decideAgentAutoSubmit({ text: "fix it", ready: false, busy: false, sendLocked: false }), "unconfigured");
  assert.equal(decideAgentAutoSubmit({ text: "fix it", ready: null, busy: false, sendLocked: false }), "pending");
  assert.equal(decideAgentAutoSubmit({ text: "fix it", ready: null, busy: true, sendLocked: true }), "pending");
  assert.equal(decideAgentAutoSubmit({ text: "  ", ready: true, busy: false, sendLocked: false }), "empty");
});
