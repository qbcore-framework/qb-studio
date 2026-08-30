import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptAgentEvent,
  agentEventCursor,
  agentEventRuntimeScope,
  nextAgentConversationGeneration,
  switchAgentEventCursor,
} from "./agentEventScope";

const oldScope = agentEventRuntimeScope("workspace-a", "gemini");
const newScope = agentEventRuntimeScope("workspace-b", "claude");

test("a new runtime adopts a main-owned handshake and then only that generation", () => {
  const initial = agentEventCursor(newScope);
  assert.equal(acceptAgentEvent({
    conversationGeneration: 7,
    runtimeScope: newScope,
    event: { type: "text", text: "current" },
  }, initial), null, "an ordinary queued event cannot establish a fresh cursor");

  const accepted = acceptAgentEvent({
    conversationGeneration: 7,
    runtimeScope: newScope,
    event: null,
  }, initial);

  assert.equal(accepted?.event, null);
  assert.deepEqual(accepted?.cursor, agentEventCursor(newScope, 7));
  assert.equal(acceptAgentEvent({
    conversationGeneration: 7,
    runtimeScope: newScope,
    event: { type: "text", text: "current" },
  }, accepted!.cursor)?.event?.type, "text");
  assert.equal(acceptAgentEvent({
    conversationGeneration: 6,
    runtimeScope: newScope,
    event: { type: "done" },
  }, accepted!.cursor), null);
});

test("a null handshake establishes the turn generation without adding a transcript event", () => {
  const accepted = acceptAgentEvent({
    conversationGeneration: 3,
    runtimeScope: oldScope,
    event: null,
  }, agentEventCursor(oldScope));
  assert.equal(accepted?.event, null);
  assert.equal(accepted?.cursor.conversationGeneration, 3);
});

test("queued events from an old runtime are rejected even with a newer generation", () => {
  assert.equal(acceptAgentEvent({
    conversationGeneration: 99,
    runtimeScope: oldScope,
    event: { type: "error", message: "stale" },
  }, agentEventCursor(newScope)), null);
});

test("rapid switches retain a generation high-water mark when no intermediate event arrives", () => {
  const firstA = agentEventCursor(oldScope, 20);
  const waitingForB = switchAgentEventCursor(firstA, newScope);
  const backToA = switchAgentEventCursor(waitingForB, oldScope);

  assert.equal(acceptAgentEvent({
    conversationGeneration: 20,
    runtimeScope: oldScope,
    event: { type: "done" },
  }, backToA), null, "the delayed event from the first A conversation stays stale");
  const accepted = acceptAgentEvent({
    conversationGeneration: 22,
    runtimeScope: oldScope,
    event: null,
  }, backToA);
  assert.equal(accepted?.cursor.conversationGeneration, 22);
});

test("an explicit reset pins the returned generation before queued events arrive", () => {
  const reset = agentEventCursor(oldScope, 12);
  assert.equal(acceptAgentEvent({
    conversationGeneration: 11,
    runtimeScope: oldScope,
    event: { type: "done" },
  }, reset), null);
  assert.equal(acceptAgentEvent({
    conversationGeneration: 12,
    runtimeScope: oldScope,
    event: { type: "text", text: "new turn" },
  }, reset)?.event?.type, "text");
});

test("generation rollover is bounded and malformed envelopes are ignored", () => {
  assert.equal(nextAgentConversationGeneration(4), 5);
  assert.equal(nextAgentConversationGeneration(Number.MAX_SAFE_INTEGER), 0);
  assert.equal(nextAgentConversationGeneration(Number.NaN), 0);
  assert.equal(acceptAgentEvent({ conversationGeneration: -1, runtimeScope: oldScope, event: { type: "done" } }, agentEventCursor(oldScope)), null);
  assert.equal(acceptAgentEvent({ conversationGeneration: 1, runtimeScope: oldScope, event: [] }, agentEventCursor(oldScope)), null);
});
