import { writeEvidence } from "../fixtures/evidence.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { recursiveTask } from "../../examples/recursive-team/task.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
type Snapshot = {
  id: string;
  parent_id: string | null;
  desired: string;
  binding: { thread_id: string };
  attempts: Array<{
    id: string;
    state: string;
    turn_id: string | null;
    result?: string;
  }>;
  messages: Array<{
    id: string;
    status: string;
    origin: string;
    sender_id: string | null;
    body: string;
  }>;
};

test(
  "real detached team: Root CLI exits before B spawns C; queued work survives Coordinator and native daemon graceful restart/SIGKILL",
  { skip: process.env.CAT_TEST_REAL !== "1", timeout: 390000 },
  async () => {
    const home = mkdtempSync("/tmp/cat-real-life-");
    const state = join(home, "team");
    const evidence: Record<string, unknown> = {
      mode: "real-model-cli-and-business-recovery",
      home,
      startedAt: new Date().toISOString(),
    };
    const call = async (command: string, ...args: string[]): Promise<unknown> =>
      JSON.parse(
        (
          await execute(
            process.execPath,
            [cli, command, ...args, "--state", state],
            { timeout: 130000, maxBuffer: 4 * 1024 * 1024 },
          )
        ).stdout,
      );
    const tree = async () => (await call("tree")) as Snapshot[];
    const wait = async (
      predicate: (snapshots: Snapshot[]) => boolean,
      seconds = 180,
    ) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        const snapshots = await tree();
        if (predicate(snapshots)) return snapshots;
        await delay(200);
      }
      throw new Error("Team state deadline exceeded");
    };
    const dead = async (pid: number) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") return;
          throw e;
        }
        await delay(50);
      }
      throw new Error("Coordinator process did not exit");
    };
    let rootId: string | undefined;
    let rootClient: ChildProcess | undefined;
    let clientHeld = false;
    try {
      await call("init", "--runtime-home", home);
      await call("start");
      const rootCall = execute(
        process.execPath,
        [
          cli,
          "root",
          "--name",
          "A",
          "--task",
          recursiveTask,
          "--wait-for-child",
          "--state",
          state,
        ],
        { timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
      );
      // Observe rejection immediately even if a later state assertion fails.
      void rootCall.catch(() => {});
      rootClient = rootCall.child;
      const registered = await wait((xs) =>
        xs.some((x) => x.parent_id === null),
      );
      rootId = registered.find((x) => x.parent_id === null)!.id;
      assert.ok(rootClient.pid);
      assert.equal(rootClient.exitCode, null);
      // Pause only this test-owned CLI client. The independent host and native
      // root continue, allowing us to observe B running before CLI exit.
      assert.equal(rootClient.kill("SIGSTOP"), true);
      clientHeld = true;
      const bRunning = await wait((xs) =>
        xs.some(
          (x) =>
            x.parent_id === rootId &&
            x.attempts.some(
              (attempt) =>
                attempt.state === "running" && attempt.turn_id !== null,
            ),
        ),
      );
      assert.equal(rootClient.exitCode, null);
      evidence.rootClientPid = rootClient.pid;
      evidence.rootCliHeldForObservation = true;
      evidence.bRunningBeforeRootExit = bRunning.find(
        (x) => x.parent_id === rootId,
      );
      evidence.bRunningObservedAt = new Date().toISOString();
      assert.equal(rootClient.kill("SIGCONT"), true);
      clientHeld = false;
      const root = JSON.parse((await rootCall).stdout) as { id: string };
      assert.equal(root.id, rootId);
      assert.equal(rootClient.exitCode, 0);
      const rootCliExitAt = Date.now();
      evidence.rootCliExitAt = new Date(rootCliExitAt).toISOString();
      await call(
        "control",
        "--target",
        root.id,
        "--action",
        "pause",
        "--scope",
        "agent",
      );
      const queued = await wait(
        (xs) =>
          xs.length === 3 &&
          xs
            .find((x) => x.id === root.id)
            ?.messages.some(
              (m) => m.origin === "agent" && m.status === "queued",
            ) === true &&
          xs.every(
            (x) =>
              x.attempts.length > 0 &&
              x.attempts.every((a) => a.state === "completed"),
          ),
      );
      evidence.beforeGracefulRestart = queued;
      const oldIds = queued.map((x) => ({
        agent: x.id,
        thread: x.binding.thread_id,
      }));
      const statusBefore = (await call("start")) as { pid: number };
      await call("stop");
      await dead(statusBefore.pid);
      await call("start");
      const after = await tree();
      evidence.afterGracefulRestart = after;
      assert.deepEqual(
        after.map((x) => ({ agent: x.id, thread: x.binding.thread_id })),
        oldIds,
      );
      assert.equal(after.find((x) => x.id === root.id)?.desired, "paused");
      assert.equal(
        after.find((x) => x.id === root.id)?.messages[0]?.id,
        queued.find((x) => x.id === root.id)?.messages[0]?.id,
      );
      const operator = (await call(
        "send",
        "--target",
        root.id,
        "--key",
        "resume-note",
        "--message",
        "Handle B’s pending answer, acknowledge all incoming message IDs with agent_ack, and output FINAL_ROOT_RESULT with the answer B actually reported.",
      )) as { messageId: string };
      evidence.operatorMessageId = operator.messageId;
      const processStatus = (await call("start")) as { pid: number };
      const command = (
        await execute(
          "ps",
          ["-p", String(processStatus.pid), "-o", "command="],
          { timeout: 10000 },
        )
      ).stdout;
      assert.ok(command.includes(cli) && command.includes(state));
      process.kill(processStatus.pid, "SIGKILL");
      await dead(processStatus.pid);
      evidence.forcedKill = {
        pid: processStatus.pid,
        scope: "verified private coordinator; native daemon left running",
      };
      await call("start");
      const afterKill = await tree();
      evidence.afterForcedRestart = afterKill;
      assert.deepEqual(
        afterKill.map((x) => ({ agent: x.id, thread: x.binding.thread_id })),
        oldIds,
      );
      assert.equal(afterKill.find((x) => x.id === root.id)?.messages.length, 2);
      assert.ok(
        afterKill
          .find((x) => x.id === root.id)
          ?.messages.every((m) => m.status === "queued"),
      );
      const currentHost = (await call("start")) as { pid: number };
      await call("stop");
      await dead(currentHost.pid);
      const nativeRestart = JSON.parse(
        (
          await execute("codex", ["app-server", "daemon", "restart"], {
            env: runtimeEnvironment(home),
            timeout: 60000,
          })
        ).stdout,
      ) as { pid: number };
      evidence.nativeGracefulRestart = nativeRestart;
      await call("start");
      const afterNativeGraceful = await tree();
      evidence.afterNativeGracefulRestart = afterNativeGraceful;
      assert.deepEqual(
        afterNativeGraceful.map((x) => ({
          agent: x.id,
          thread: x.binding.thread_id,
        })),
        oldIds,
      );
      assert.ok(
        afterNativeGraceful
          .find((x) => x.id === root.id)
          ?.messages.every((m) => m.status === "queued"),
      );
      assert.ok(
        Number.isSafeInteger(nativeRestart.pid) && nativeRestart.pid > 1,
      );
      const nativeCommand = (
        await execute(
          "ps",
          ["-p", String(nativeRestart.pid), "-o", "command="],
          { timeout: 10000 },
        )
      ).stdout;
      assert.ok(
        nativeCommand.includes(home) && nativeCommand.includes("app-server"),
      );
      process.kill(nativeRestart.pid, "SIGKILL");
      await dead(nativeRestart.pid);
      evidence.nativeForcedKill = {
        pid: nativeRestart.pid,
        scope: "verified dedicated native daemon; no user daemon touched",
      };
      const disconnectedHost = (await call("start")) as { pid: number };
      await call("stop");
      await dead(disconnectedHost.pid);
      await execute("codex", ["app-server", "daemon", "restart"], {
        env: runtimeEnvironment(home),
        timeout: 60000,
      });
      await call("start");
      const afterNativeForced = await tree();
      evidence.afterNativeForcedRestart = afterNativeForced;
      assert.deepEqual(
        afterNativeForced.map((x) => ({
          agent: x.id,
          thread: x.binding.thread_id,
        })),
        oldIds,
      );
      assert.equal(
        afterNativeForced.find((x) => x.id === root.id)?.desired,
        "paused",
      );
      assert.equal(
        afterNativeForced.find((x) => x.id === root.id)?.messages.length,
        2,
      );
      assert.ok(
        afterNativeForced
          .find((x) => x.id === root.id)
          ?.messages.every((m) => m.status === "queued"),
      );
      await call(
        "control",
        "--target",
        root.id,
        "--action",
        "resume",
        "--scope",
        "agent",
      );
      const completed = await wait((xs) => {
        const current = xs.find((x) => x.id === root.id);
        if ((current?.attempts.length ?? 0) > 2)
          throw new Error("Unexpected duplicate Root wake");
        return (
          current?.attempts.length === 2 &&
          current.attempts.every((a) => a.state === "completed") &&
          current.attempts.some((a) =>
            /FINAL_ROOT_RESULT[\s\S]*\b42\b/.test(a.result ?? ""),
          ) &&
          xs.every((x) => x.attempts.every((a) => a.state === "completed"))
        );
      }, 90);
      evidence.completed = completed;
      const b = completed.find((x) => x.parent_id === root.id);
      assert.ok(b);
      const c = completed.find((x) => x.parent_id === b.id);
      assert.ok(c);
      assert.equal(completed.find((x) => x.id === root.id)?.attempts.length, 2);
      assert.equal(b.attempts.length, 2);
      assert.equal(c.attempts.length, 1);
      assert.ok(
        completed
          .find((x) => x.id === root.id)
          ?.messages.every((m) => m.status === "processed"),
      );
      assert.equal(b.messages[0]?.status, "processed");
      assert.match(b.messages[0]!.body, /\b42\b/);
      assert.match(
        completed
          .find((x) => x.id === root.id)!
          .messages.find((m) => m.origin === "agent")!.body,
        /\b42\b/,
      );
      const rootComplete = completed.find((x) => x.id === root.id)!;
      assert.ok(
        rootComplete.attempts.some((a) =>
          /FINAL_ROOT_RESULT[\s\S]*\b42\b/.test(a.result ?? ""),
        ),
      );
      assert.equal(
        rootComplete.messages.find((m) => m.origin === "agent")?.sender_id,
        b.id,
      );
      assert.equal(b.messages[0]?.sender_id, c.id);
      const bEvents = (await call("events", "--target", b.id)) as Array<{
        kind: string;
        created_at: string;
      }>;
      evidence.bEvents = bEvents;
      const spawned = c.id;
      const cEvents = (await call("events", "--target", spawned)) as Array<{
        kind: string;
        created_at: string;
      }>;
      evidence.cEvents = cEvents;
      const rootEvents = (await call("events", "--target", root.id)) as Array<{
        kind: string;
        created_at: string;
      }>;
      evidence.rootEvents = rootEvents;
      assert.equal(
        [...bEvents, ...cEvents, ...rootEvents].filter(
          (e) => e.kind === "tool.rejected",
        ).length,
        0,
      );
      const spawn = cEvents.find((e) => e.kind === "spawn.accepted");
      assert.ok(spawn);
      assert.ok(
        Date.parse(spawn.created_at) > rootCliExitAt,
        "B must actually spawn C after the Root CLI process exits",
      );
      evidence.passed = true;
    } catch (error) {
      evidence.passed = false;
      evidence.error = String(error);
      try {
        evidence.failureSnapshots = await tree();
        if (rootId)
          evidence.rootEvents = await call("events", "--target", rootId);
      } catch {
        evidence.failureSnapshotUnavailable = true;
      }
      throw error;
    } finally {
      if (
        rootClient &&
        rootClient.exitCode === null &&
        rootClient.signalCode === null
      ) {
        if (clientHeld) rootClient.kill("SIGCONT");
        rootClient.kill("SIGTERM");
      }
      try {
        await call("stop");
      } catch {
        /* Exact owned daemon cleanup remains below even if the coordinator crashed. */
      }
      try {
        await execute("codex", ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
        });
      } finally {
        if (existsSync(join(home, "auth.json")))
          unlinkSync(join(home, "auth.json"));
        evidence.finishedAt = new Date().toISOString();
        writeEvidence("persistent-real-lifecycle.json", evidence);
      }
    }
  },
);
