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
