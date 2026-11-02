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
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import {
  CodexRuntime,
  record,
  runtimeEnvironment,
} from "../../src/runtime/codex/adapter.ts";
import { workspacePolicy } from "../../src/workspace/broker.ts";

const exec = promisify(execFile);
const enabled = process.env.CAT_TEST_ASYNC_LIFECYCLE_NATIVE === "1";
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeout = 60000,
) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(50);
  assert.ok(predicate(), `Timed out waiting for ${label}`);
}

async function fixture() {
  const config = process.env.CAT_PROVIDER_CONFIG;
  const envKey = process.env.CAT_PROVIDER_ENV;
  const executable = process.env.CAT_PROVIDER_EXECUTABLE;
  const service = process.env.CAT_PROVIDER_KEYCHAIN_SERVICE;
  assert.ok(
    config && envKey && executable,
    "Set CAT_PROVIDER_CONFIG, CAT_PROVIDER_ENV, CAT_PROVIDER_EXECUTABLE",
  );
  const original = readFileSync(config);
  const base = mkdtempSync("/tmp/cat-native-life-");
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
  writeFileSync(join(repo, "fixture.txt"), "isolated\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const credential = {
    envKey,
    ...(service ? { keychainService: service } : {}),
  };
  const runtime = new CodexRuntime({ home, executable, credential });
  let c: Coordinator | undefined;
  try {
    await exec(
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
    c = new Coordinator(
      {
        stateDirectory: state,
        runtimeHome: home,
        executable,
        credential,
        workspace: workspacePolicy(repo, {}),
      },
      runtime,
    );
    await c.start();
  } catch (error) {
    if (c) await c.stop();
    try {
      await exec(executable, ["app-server", "daemon", "stop"], {
        env: runtimeEnvironment(home),
        timeout: 30000,
      });
      rmSync(base, { recursive: true, force: true });
    } catch {}
    throw error;
  }
  const coordinator = c;
  const responses: {
    tool: string;
    success: boolean;
    payload: Record<string, unknown>;
  }[] = [];
  const respond = runtime.respond.bind(runtime);
  runtime.respond = (request, result) => {
    const tool = String(record(request.params).tool ?? "");
    const value = record(result);
    if (["terminal_start", "terminal_stop", "terminal_status"].includes(tool)) {
      const item = Array.isArray(value.contentItems)
        ? record(value.contentItems[0])
        : {};
      let payload: Record<string, unknown> = {};
      try {
        if (typeof item.text === "string")
          payload = record(JSON.parse(item.text));
      } catch {}
      responses.push({ tool, success: value.success === true, payload });
    }
    respond(request, result);
  };
  return {
    base,
    repo,
    state,
    home,
    runtime,
    coordinator,
    responses,
    async close() {
      try {
        await coordinator.stop();
      } finally {
        let stopped = false;
        try {
          await exec(executable, ["app-server", "daemon", "stop"], {
            env: runtimeEnvironment(home),
            timeout: 30000,
          });
          stopped = true;
        } finally {
          assert.deepEqual(readFileSync(config), original);
          if (stopped) rmSync(base, { recursive: true, force: true });
        }
      }
    },
  };
}

const limits = {
  tokenPolicy: "observe" as const,
  tokens: 100000,
  maxDepth: 0,
  maxAgents: 1,
  maxConcurrentTurns: 1,
  maxTurnsPerAgent: 2,
  maxTotalTurns: 2,
  turnReservation: 1000,
};

test(
  "real Codex CLI model stops an accepted background command and sees the settled receipt",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const f = await fixture();
    try {
      const root = f.coordinator.createRoot(
        "Lead",
        "Call terminal_start once with command `sleep 30`. Call terminal_stop with the returned commandId immediately. Then call terminal_status for that ID until state completed and the stop result is visible. Do not use terminal, network, other agents or unrelated tools. Say STOP_TEST_DONE after seeing the result.",
        limits,
        "native-stop",
      );
      await waitFor(
        () =>
          f.coordinator.store
            .attempts(root.id)
            .some((a) =>
              ["completed", "failed", "interrupted", "unknown"].includes(
                a.state,
              ),
            ),
        "native turn",
      );
      const attempts = f.coordinator.store.attempts(root.id);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]!.state, "completed");
      const start = f.responses.find(
        (r) =>
          r.tool === "terminal_start" &&
          r.success &&
          r.payload.state === "running",
      );
      assert.ok(
        start && typeof start.payload.commandId === "string",
        "missing accepted native start",
      );
      assert.ok(
        f.responses.some(
          (r) =>
            r.tool === "terminal_stop" &&
            r.success &&
            r.payload.stopRequested === true,
        ),
        "missing accepted native stop",
      );
      assert.ok(
        f.responses.some(
          (r) =>
            r.tool === "terminal_status" &&
            r.success &&
            r.payload.state === "completed" &&
            record(r.payload.result).stopped === "cancelled",
        ),
        "model never observed stopped result",
      );
      const receipt = f.coordinator.store.workspaceCommand(
        root.id,
        start.payload.commandId,
      );
      assert.equal(receipt.state, "completed");
      assert.equal(record(receipt.result).stopped, "cancelled");
      assert.equal(
        f.coordinator.store.workspaceCommandSummary(root.id)!.total,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "real Codex CLI replacement drains a background command after the original Turn completes",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const f = await fixture();
    try {
      const root = f.coordinator.createRoot(
        "Lead",
        "Call terminal_start once with the command `sleep 30`. Once it returns running, end your turn immediately with the text OLD_TURN_DONE. Do not stop the command, do not call any other tools, and do not spawn agents.",
        limits,
        "native-replace",
      );
      await waitFor(
        () =>
          f.coordinator.store
            .attempts(root.id)
            .some((a) =>
              ["completed", "failed", "interrupted", "unknown"].includes(
                a.state,
              ),
            ),
        "original native turn",
      );
      const first = f.coordinator.store.attempts(root.id);
      assert.equal(first.length, 1);
      assert.equal(first[0]!.state, "completed");
      const start = f.responses.find(
        (r) =>
          r.tool === "terminal_start" &&
          r.success &&
          r.payload.state === "running",
      );
      assert.ok(
        start && typeof start.payload.commandId === "string",
        "missing accepted native start",
      );
      assert.equal(
        f.coordinator.store.workspaceCommand(root.id, start.payload.commandId)
          .state,
        "accepted",
      );
      const replacement = await f.coordinator.replaceScope(
        root.id,
        "native-replacement",
        0,
        "Reply exactly NEW_SCOPE_DONE and finish without invoking any tools.",
      );
      assert.equal(replacement.state, "draining");
      await waitFor(
        () =>
          f.coordinator.store.workspaceCommand(
            root.id,
            start.payload.commandId as string,
          ).state === "completed",
        "cancelled background receipt",
      );
      await waitFor(
        () =>
          f.coordinator.store.scopes.progress(replacement.receipt.id).state ===
          "ready",
        "scope readiness without additional input",
      );
      await waitFor(
        () =>
          f.coordinator.store.attempts(root.id).length === 2 &&
          f.coordinator.store.attempts(root.id)[1]?.state === "completed",
        "replacement native turn",
      );
      const attempts = f.coordinator.store.attempts(root.id);
      assert.equal(attempts.length, 2);
      assert.notEqual(attempts[0]!.id, attempts[1]!.id);
      assert.equal(
        record(
          f.coordinator.store.workspaceCommand(root.id, start.payload.commandId)
            .result,
        ).stopped,
        "cancelled",
      );
      assert.equal(
        f.coordinator.store.workspaceCommandSummary(root.id)!.total,
        1,
      );
    } finally {
      await f.close();
    }
  },
);
