import { test } from "node:test";
import assert from "node:assert/strict";
import {
  spawnInput,
  sendInput,
  controlInput,
  ackInput,
} from "../../src/tools/inputs.ts";
test("tool input cannot select sender, parent, runtime domain, permission or binding generation", () => {
  const spawn = {
    requestKey: "one",
    name: "B",
    role: "worker",
    task: "test",
    tokens: 100,
  };
  for (const key of [
    "agent_id",
    "agentId",
    "parent_id",
    "sender_id",
    "runtimeDomain",
    "bindingGeneration",
    "permissions",
  ]) {
    assert.throws(() => spawnInput({ ...spawn, [key]: "spoof" }));
    assert.throws(() =>
      sendInput({
        requestKey: "reply",
        target: "B",
        message: "42",
        [key]: "spoof",
      }),
    );
  }
  assert.equal(spawnInput(spawn).tokens, 100);
});
test("tool bounds reject malformed cost and control escalation", () => {
  assert.throws(() =>
    spawnInput({
      requestKey: "one",
      name: "B",
      role: "worker",
      task: "test",
      tokens: -1,
    }),
  );
  assert.throws(() => controlInput({ target: "B", action: "approve" }));
  assert.throws(() => ackInput({ messageIds: [""] }));
  assert.deepEqual(controlInput({ target: "B", action: "pause" }), {
    target: "B",
    action: "pause",
    scope: "subtree",
  });
});

test("accepted message escapes remain bounded and malformed UTF-16 cannot be silently changed in storage", () => {
  for (const message of [
    '"'.repeat(12000),
    "\\".repeat(12000),
    "\t".repeat(11999) + "x",
    "😀".repeat(6000),
  ]) {
    const input = sendInput({
      requestKey: "edge",
      target: "recipient",
      message,
    });
    assert.equal(input.message, message);
    assert.ok(JSON.stringify(message).length <= 24002);
  }
  for (const message of [
    "\u0001".repeat(12000),
    "\ud800".repeat(12000),
    "\udc00",
    "valid prefix\ud800",
  ]) {
    assert.throws(
      () => sendInput({ requestKey: "edge", target: "recipient", message }),
      /Invalid message/,
    );
  }
});
