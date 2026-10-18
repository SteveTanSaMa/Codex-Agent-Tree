import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  scriptedProvider,
  response,
  emit,
} from "../fixtures/scripted-provider.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((r) => setTimeout(r, 20));
  }
}
test(
  "actual Coordinator SIGKILL after a sandboxed effect retains an unknown command receipt and never repeats it on restart",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 180000 },
  async () => {
    for (let repetition = 0; repetition < 3; repetition++) {
      const base = mkdtempSync("/tmp/cat-host-crash-"),
        repo = join(base, "repo"),
        home = join(base, "h"),
        state = join(base, "s");
      mkdirSync(repo);
      await execute("git", ["-C", repo, "init"]);
      await execute("git", ["-C", repo, "config", "user.name", "Fixture"]);
      await execute("git", [
        "-C",
        repo,
        "config",
        "user.email",
        "fixture@example.invalid",
      ]);
      writeFileSync(join(repo, "source"), "fixture");
      await execute("git", ["-C", repo, "add", "."]);
      await execute("git", ["-C", repo, "commit", "-m", "fixture"]);
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      const effect =
        "const fs=require('node:fs');fs.writeFileSync('effect-pid',String(process.pid));const n=fs.existsSync('effect')?Number(fs.readFileSync('effect','utf8')):0;fs.writeFileSync('effect',String(n+1));setTimeout(()=>{},12000)";
      const provider = await scriptedProvider(home, (_body, res, count) => {
        if (count === 1)
          response(
            res,
            {
              type: "function_call",
              id: "fc_effect",
              call_id: "effect_call",
              name: "terminal",
              arguments: JSON.stringify({
                command: quote(process.execPath) + " -e " + quote(effect),
              }),
            },
            "resp_effect",
          );
        else {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          emit(res, "response.created", {
            response: { id: "resp_hold", status: "in_progress", output: [] },
          });
        }
      });
      const executable = process.env.CAT_TEST_CODEX ?? "codex";
      const call = async (...args: string[]) =>
        JSON.parse(
          (
            await execute(process.execPath, [cli, ...args, "--state", state], {
              timeout: 45000,
              maxBuffer: 4 * 1024 * 1024,
            })
          ).stdout,
        );
      try {
        await call(
          "init",
          "--runtime-home",
          home,
          "--config-from",
          join(home, "config.toml"),
          "--provider-env",
          provider.credential.envKey,
          "--workspace",
          repo,
          ...(process.env.CAT_TEST_CODEX ? ["--executable", executable] : []),
        );
        const started = await call("start");
        const root = await call(
          "root",
          "--key",
          "root",
          "--task",
          "Execute the supplied synthetic terminal tool once",
          "--max-turns",
          "2",
          "--max-total-turns",
          "2",
        );
        await until(
          () => existsSync(join(repo, "effect")),
          "sandbox effect never started",
        );
        assert.equal(readFileSync(join(repo, "effect"), "utf8"), "1");
        const db = new DatabaseSync(join(state, "business.sqlite"), {
          readOnly: true,
        });
        let receipt: Record<string, any>;
        try {
          receipt = db
            .prepare("SELECT * FROM workspace_commands WHERE agent_id=?")
            .get(root.id)!;
          assert.equal(receipt.state, "accepted");
          assert.equal(receipt.result_json, null);
        } finally {
          db.close();
        }
        process.kill(Number(started.pid), "SIGKILL");
        const effectPid = Number(
          readFileSync(join(repo, "effect-pid"), "utf8"),
        );
        await until(() => {
          try {
            process.kill(effectPid, 0);
            return false;
          } catch (e) {
            return (e as NodeJS.ErrnoException).code === "ESRCH";
          }
        }, "supervisor did not stop the orphaned effect process");
        await call("start");
        await call(
          "control",
          "--target",
          root.id,
          "--action",
          "pause",
          "--immediate",
        );
        await until(
          async () =>
            (await call("status", "--target", root.id)).execution === "idle",
          "native Turn did not settle",
        );
        const status = await call("status", "--target", root.id);
        assert.equal(status.attemptCount, 1);
        assert.equal(status.workspace.commandSummary.unresolved, 1);
        assert.equal(status.workspace.commands[0].state, "accepted");
        assert.equal(readFileSync(join(repo, "effect"), "utf8"), "1");
        const reviewed = await call(
          "command-review",
          "--target",
          root.id,
          "--call-id",
          String(receipt!.call_id),
          "--reason",
          "Verified synthetic effect counter and supervisor exit; final outcome unknown",
        );
        assert.equal(reviewed.outcome, "reviewed-unknown");
        assert.equal(reviewed.replayAllowed, false);
        assert.equal(readFileSync(join(repo, "effect"), "utf8"), "1");
      } finally {
        try {
          if (existsSync(join(state, "control.sock"))) await call("stop");
        } finally {
          try {
            await execute(executable, ["app-server", "daemon", "stop"], {
              env: runtimeEnvironment(home),
              timeout: 20000,
            });
          } finally {
            await provider.close();
            rmSync(base, {
              recursive: true,
              force: true,
              maxRetries: 10,
              retryDelay: 100,
            });
          }
        }
      }
    }
  },
);
