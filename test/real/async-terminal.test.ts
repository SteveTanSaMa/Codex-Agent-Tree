import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import {
  CodexRuntime,
  record,
  runtimeEnvironment,
} from "../../src/runtime/codex/adapter.ts";
import { workspacePolicy } from "../../src/workspace/broker.ts";

const execute = promisify(execFile);

test(
  "real Codex CLI model invokes background terminal and observes its completed result",
  {
    skip: process.env.CAT_TEST_ASYNC_NATIVE !== "1",
    timeout: 180000,
  },
  async () => {
    const config = process.env.CAT_PROVIDER_CONFIG;
    const envKey = process.env.CAT_PROVIDER_ENV;
    const executable = process.env.CAT_PROVIDER_EXECUTABLE;
    const service = process.env.CAT_PROVIDER_KEYCHAIN_SERVICE;
    assert.ok(
      config && envKey && executable,
      "Set CAT_PROVIDER_CONFIG, CAT_PROVIDER_ENV and CAT_PROVIDER_EXECUTABLE explicitly",
    );
    const original = readFileSync(config);
    const base = mkdtempSync("/tmp/cat-async-native-");
    chmodSync(base, 0o700);
    const repo = join(base, "repo"),
      state = join(base, "s"),
      home = join(base, "h");
    mkdirSync(repo);
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git(["init"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(repo, "fixture.txt"), "isolated test\n");
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    let coordinator: Coordinator | undefined;
    let daemonStopped = false;
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
      assert.ok(
        JSON.parse(init.stdout).initialized,
        "public CLI initialization failed",
      );
      const credential = {
        envKey,
        ...(service ? { keychainService: service } : {}),
      };
      const runtime = new CodexRuntime({ home, executable, credential });
      const seen = { startAccepted: false, completedStatusObserved: false };
      const respond = runtime.respond.bind(runtime);
      runtime.respond = (request, result) => {
        const tool = record(request.params).tool;
        const value = record(result);
        if (
          value.success === true &&
          (tool === "terminal_start" || tool === "terminal_status")
        ) {
          const item = Array.isArray(value.contentItems)
            ? record(value.contentItems[0])
            : {};
          if (typeof item.text === "string") {
            const payload = record(JSON.parse(item.text));
            if (
              tool === "terminal_start" &&
              payload.state === "running" &&
              typeof payload.commandId === "string"
            )
              seen.startAccepted = true;
            if (
              tool === "terminal_status" &&
              payload.state === "completed" &&
              record(payload.result).exitCode === 0 &&
              String(record(payload.result).output).includes(
                "CAT_ASYNC_NATIVE_OK",
              )
            )
              seen.completedStatusObserved = true;
          }
        }
        respond(request, result);
      };
      coordinator = new Coordinator(
        {
          stateDirectory: state,
          runtimeHome: home,
          executable,
          credential,
          workspace: workspacePolicy(repo, {}),
        },
        runtime,
      );
      await coordinator.start();
      const root = coordinator.createRoot(
        "Lead",
        "Use terminal_start exactly once with command `printf CAT_ASYNC_NATIVE_OK`. Then use terminal_status with the returned commandId until state is completed and its result is visible. Do not use terminal, other shell commands, other Agents, network or additional work. After observing completion, say ASYNC_NATIVE_FINISHED and end this turn.",
        {
          tokenPolicy: "observe",
          tokens: 100000,
          maxDepth: 0,
          maxAgents: 1,
          maxConcurrentTurns: 1,
          maxTurnsPerAgent: 1,
          maxTotalTurns: 1,
          turnReservation: 1000,
        },
        "async-native-once",
      );
      const deadline = Date.now() + 110000;
      while (
        Date.now() < deadline &&
        !coordinator.store
          .attempts()
          .some((a) =>
            ["completed", "failed", "interrupted", "unknown"].includes(a.state),
          )
      )
        await delay(200);
      const attempts = coordinator.store.attempts();
      assert.equal(attempts.length, 1, "Exactly one native Turn is required");
      assert.equal(
        attempts[0]!.state,
        "completed",
        "Native Turn did not complete",
      );
      assert.equal(
        seen.startAccepted,
        true,
        "Model did not invoke terminal_start successfully",
      );
      assert.equal(
        seen.completedStatusObserved,
        true,
        "Model did not observe terminal_status completed with actual successful output",
      );
      const receipts = coordinator.store.db
        .prepare("SELECT state FROM workspace_commands WHERE agent_id=?")
        .all(root.id);
      assert.equal(receipts.length, 1, "Expected exactly one command receipt");
      assert.equal(receipts[0]!.state, "completed");
      console.log(
        "Native asynchronous terminal: one actual model Turn, successful host receipt, and completed status response verified.",
      );
    } finally {
      if (coordinator) await coordinator.stop();
      try {
        await execute(executable, ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
        });
        daemonStopped = true;
      } finally {
        assert.equal(
          readFileSync(config).equals(original),
          true,
          "Provider config was modified",
        );
        if (daemonStopped) rmSync(base, { recursive: true, force: true });
      }
    }
  },
);
