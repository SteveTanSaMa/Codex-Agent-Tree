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
