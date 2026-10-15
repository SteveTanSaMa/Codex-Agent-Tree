import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

test(
  "native detached CLI host survives start client exit and supports independent control clients",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 100000 },
  async () => {
    const home = mkdtempSync("/tmp/cat-cli-native-");
    const state = join(home, "team");
    const call = async (...args: string[]) =>
      JSON.parse(
        (
          await execute(process.execPath, [cli, ...args, "--state", state], {
            timeout: 70000,
          })
        ).stdout,
      ) as Record<string, unknown>;
    let coordinatorPid: number | undefined;
    try {
      await call("init", "--runtime-home", home);
      const started = await call("start");
      assert.equal(started.ready, true);
      coordinatorPid = Number(started.pid);
      assert.ok(coordinatorPid > 1);
      process.kill(coordinatorPid, 0);
      assert.deepEqual(await call("tree"), []);
      const again = await call("start");
      assert.equal(again.pid, coordinatorPid); // No duplicate writer or daemon.
      await call("stop");
      const deadline = Date.now() + 10000;
      let exited = false;
      while (Date.now() < deadline) {
        try {
          process.kill(coordinatorPid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            exited = true;
            break;
          }
          throw e;
        }
        await delay(50);
      }
      assert.equal(exited, true);
    } finally {
      if (coordinatorPid) {
        try {
          await call("stop");
        } catch {
          /* Already stopped; native daemon cleanup below is independent. */
        }
      }
      try {
        await execute("codex", ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
        });
      } finally {
        const auth = join(home, "auth.json");
        if (existsSync(auth)) unlinkSync(auth);
      }
    }
  },
);
