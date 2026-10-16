import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
test("CLI --wait-for-child waits for an observed child and preserves the root operation key", async () => {
  const state = mkdtempSync("/tmp/cat-cli-control-");
  writeFileSync(join(state, "operator-token"), "fixture-secret", {
    mode: 0o600,
  });
  let lists = 0;
  let rootKey: unknown;
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += String(data);
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      const request = JSON.parse(buffer.slice(0, i)) as {
        token: string;
        method: string;
        params: { requestKey?: string };
      };
      assert.equal(request.token, "fixture-secret");
      if (request.method === "root") {
        rootKey = request.params.requestKey;
        socket.end(JSON.stringify({ result: { id: "root-id" } }) + "\n");
      } else {
        lists++;
        socket.end(
          JSON.stringify({
            result: lists < 3 ? [] : [{ parent_id: "root-id" }],
          }) + "\n",
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(join(state, "control.sock"), r));
  try {
    const result = await execute(
      process.execPath,
      [
        fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
        "root",
        "--task",
        "delegate",
        "--key",
        "stable-root-key",
        "--wait-for-child",
        "--state",
        state,
      ],
      { timeout: 10000 },
    );
    assert.equal(JSON.parse(result.stdout).id, "root-id");
    assert.equal(lists, 3);
    assert.equal(rootKey, "stable-root-key");
  } finally {
    await new Promise<void>((yes, no) =>
      server.close((error) => (error ? no(error) : yes())),
    );
    rmSync(state, { recursive: true, force: true });
  }
});

test("serve never removes an existing regular file at the control socket path", async () => {
  const state = mkdtempSync("/tmp/cat-cli-file-");
  const control = join(state, "control.sock");
  writeFileSync(control, "user data must survive");
  writeFileSync(
    join(state, "config.json"),
    JSON.stringify({
      stateDirectory: state,
      runtimeHome: join(state, "runtime"),
      executable: process.execPath,
      expectedVersion: "fixture",
    }),
  );
  try {
    await assert.rejects(
      execute(
        process.execPath,
        [
          fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
          "serve",
          "--state",
          state,
        ],
        { timeout: 10000 },
      ),
      /Refusing to remove a non-socket/,
    );
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(control, "utf8"), "user data must survive");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("CLI responses preserve UTF-8 split inside a character", async () => {
  const state = mkdtempSync("/tmp/cat-cli-utf8-");
  writeFileSync(join(state, "operator-token"), "fixture-secret");
  const text = "你好，🌲";
  const server = createServer((socket) =>
    socket.once("data", () => {
      const bytes = Buffer.from(JSON.stringify({ result: { text } }) + "\n");
      const boundary = bytes.indexOf(Buffer.from("你")) + 1;
      socket.write(bytes.subarray(0, boundary));
      setTimeout(() => socket.end(bytes.subarray(boundary)), 30);
    }),
  );
  await new Promise<void>((r) => server.listen(join(state, "control.sock"), r));
  try {
    const result = await execute(
      process.execPath,
      [
        fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
        "status",
        "--target",
        "root",
        "--state",
        state,
      ],
      { timeout: 5000 },
    );
    assert.equal(JSON.parse(result.stdout).text, text);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(state, { recursive: true, force: true });
  }
});

test("public Skill forwards steering, immediate pause and explicit policy commands", async () => {
  const state = mkdtempSync("/tmp/cat-interactive-cli-");
  writeFileSync(join(state, "operator-token"), "fixture-secret");
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += String(chunk);
      if (!data.includes("\n")) return;
      const r = JSON.parse(data.trim());
      requests.push(r);
      socket.end(JSON.stringify({ result: { ok: true } }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(join(state, "control.sock"), r));
  const call = (...args: string[]) =>
    execute(process.execPath, ["scripts/cat.mjs", ...args, "--state", state], {
      timeout: 5000,
    });
  try {
    await call(
      "steer",
      "--target",
      "A",
      "--message",
      "correct",
      "--key",
      "stable",
    );
    assert.equal(requests.at(-1)!.method, "send");
    assert.equal(requests.at(-1)!.params.delivery, "steer");
    await call(
      "send",
      "--target",
      "A",
      "--message",
      "later",
      "--delivery",
      "queue",
    );
    assert.equal(requests.at(-1)!.params.delivery, "queue");
    await call("control", "--target", "A", "--action", "pause", "--immediate");
    assert.equal(requests.at(-1)!.params.immediate, true);
    await call(
      "root",
      "--task",
      "work",
      "--mode",
      "batch",
      "--task-token-budget",
      "5000",
    );
    assert.equal(requests.at(-1)!.params.mode, "batch");
    assert.equal(requests.at(-1)!.params.taskTokenBudget, "5000");
    await call(
      "token-reminder",
      "--target",
      "A",
      "--scope",
      "tree",
      "--threshold",
      "100",
      "--every",
      "50",
      "--metric",
      "output",
    );
    assert.equal(requests.at(-1)!.method, "token-reminder");
    assert.deepEqual(requests.at(-1)!.params.policy, {
      metric: "output",
      thresholdTokens: 100,
      repeatEveryTokens: 50,
    });
    await call("token-reminder", "--target", "A", "--disable");
    assert.equal(requests.at(-1)!.params.policy, null);
    writeFileSync(
      join(state, "policy.json"),
      JSON.stringify({ autonomyPauseMs: 60000 }),
    );
    await call(
      "interaction",
      "--target",
      "A",
      "--input-file",
      join(state, "policy.json"),
    );
    assert.equal(requests.at(-1)!.method, "interaction");
    await call("check-in", "--target", "A");
    assert.equal(requests.at(-1)!.method, "check-in");
    await call(
      "guidance-resolve",
      "--target",
      "A",
      "--message-id",
      "M",
      "--outcome",
      "retry-next",
      "--reason",
      "reviewed",
    );
    assert.equal(requests.at(-1)!.params.outcome, "retry-next");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(state, { recursive: true, force: true });
  }
});
