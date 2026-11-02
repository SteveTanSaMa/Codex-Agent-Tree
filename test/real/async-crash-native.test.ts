import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
import { workspacePolicy } from "../../src/workspace/broker.ts";

const execute = promisify(execFile);

test(
  "real CLI recovers accepted background command after Coordinator SIGKILL without replay",
  {
    skip: process.env.CAT_TEST_ASYNC_CRASH_NATIVE !== "1",
    timeout: 180000,
  },
  async () => {
    const config = process.env.CAT_PROVIDER_CONFIG;
    const envKey = process.env.CAT_PROVIDER_ENV;
    const executable = process.env.CAT_PROVIDER_EXECUTABLE;
    const service = process.env.CAT_PROVIDER_KEYCHAIN_SERVICE;
    assert.ok(
      config && envKey && executable,
      "Explicit provider config, env key and executable are required",
    );
    const originalConfig = readFileSync(config);
    const base = realpathSync(mkdtempSync("/tmp/cat-native-crash-"));
    chmodSync(base, 0o700);
    const repo = join(base, "repo"),
      state = join(base, "s"),
      home = join(base, "h");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repo, "fixture.txt"), "fixture\n");
    git("add", ".");
    git("commit", "-m", "fixture");
    const workspace = workspacePolicy(repo, {});
    let host: ChildProcess | undefined;
    let c: Coordinator | undefined;
    let commandPid: number | undefined;
    let daemonStopped = false;
    let hostErrors = "";
    try {
      const init = await execute(
        process.execPath,
        [
          "scripts/cat.mjs",
          "init",
          "--state",
          state,
          "--runtime-home",
          home,
          "--workspace",
          repo,
          "--config-from",
          config,
          "--provider-env",
          envKey,
          "--executable",
          executable,
          ...(service ? ["--keychain-service", service] : []),
        ],
        { timeout: 30000 },
      );
      assert.ok(JSON.parse(init.stdout).initialized);
      host = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../fixtures/native-async-crash-host.ts", import.meta.url),
          ),
          state,
          home,
          repo,
          executable,
          envKey,
          service ?? "",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      host.stderr!.on("data", (chunk: Buffer) => {
        hostErrors += chunk.toString().slice(0, 4096);
      });
      const ready = join(state, "crash-ready.json");
      const deadline = Date.now() + 100000;
      while (
        (!existsSync(ready) || !existsSync(join(repo, "crash-pid"))) &&
        host.exitCode === null &&
        Date.now() < deadline
      )
        await delay(50);
      assert.ok(
        existsSync(ready) && existsSync(join(repo, "crash-pid")),
        `Native host did not reach crash boundary: ${hostErrors}`,
      );
      const snapshot = JSON.parse(readFileSync(ready, "utf8"));
      commandPid = Number(readFileSync(join(repo, "crash-pid"), "utf8").trim());
      assert.ok(Number.isSafeInteger(commandPid) && commandPid > 1);
      const ps = () => {
        try {
          return execFileSync(
            "ps",
            ["-p", String(commandPid), "-o", "stat=,args="],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ).trim();
        } catch {
          return "";
        }
      };
      assert.match(ps(), /sleep 120/);
      assert.equal(readFileSync(join(repo, "crash-effects"), "utf8"), "x");
      const exited = once(host, "exit");
      host.kill("SIGKILL");
      await exited;
      const killDeadline = Date.now() + 5000;
      while (ps() && !ps().startsWith("Z") && Date.now() < killDeadline)
        await delay(25);
      assert.ok(
        !ps() || ps().startsWith("Z"),
        "supervised command survived coordinator death",
      );
      const credential = {
        envKey,
        ...(service ? { keychainService: service } : {}),
      };
      c = new Coordinator({
        stateDirectory: state,
        runtimeHome: home,
        executable,
        credential,
        workspace,
      });
      await c.start();
      const attempts = c.store.attempts(snapshot.rootId);
      assert.equal(
        attempts.length,
        1,
        "restart dispatched an additional native Turn",
      );
      assert.equal(attempts[0]!.id, snapshot.attempt.id);
      assert.equal(attempts[0]!.turn_id, snapshot.attempt.turn_id);
      assert.equal(attempts[0]!.state, "completed");
      assert.equal(
        c.store.binding(snapshot.rootId)?.thread_id,
        snapshot.binding.thread_id,
      );
      assert.equal(
        c.store.workspaceCommand(snapshot.rootId, snapshot.commandId).state,
        "accepted",
      );
      assert.equal(
        c.workspace?.backgroundCommandRunning(
          snapshot.rootId,
          snapshot.commandId,
        ),
        false,
      );
      await delay(1000);
      const native = await c.nativeHistory(snapshot.rootId);
      const turns = (native.thread as { turns: { id: string }[] }).turns;
      assert.deepEqual(
        turns.map((turn) => turn.id),
        [snapshot.attempt.turn_id],
        "native history must contain exactly the original Turn",
      );
      assert.equal(c.store.attempts(snapshot.rootId).length, 1);
      assert.equal(
        readFileSync(join(repo, "crash-effects"), "utf8"),
        "x",
        "background effect was repeated",
      );
      console.log(
        "Real CLI SIGKILL recovery: original Thread/Turn preserved, supervisor stopped, accepted receipt remains unknown, no replay observed.",
      );
    } finally {
      if (host && host.exitCode === null && host.signalCode === null) {
        host.kill("SIGKILL");
        await once(host, "exit").catch(() => {});
      }
      if (c) await c.stop();
      try {
        await execute(executable, ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
        });
        daemonStopped = true;
      } finally {
        assert.deepEqual(readFileSync(config), originalConfig);
        if (daemonStopped)
          rmSync(base, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        else
          console.error(
            `Preserved native crash fixture for manual inspection: ${base}`,
          );
      }
    }
  },
);
