import { writeEvidence } from "../fixtures/evidence.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { Store } from "../../src/storage/store.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
import { recursiveTask } from "../../examples/recursive-team/task.ts";
const execute = promisify(execFile);

test(
  "real persistent Coordinator: actual A→B→C→B→A with independent Threads and processed receipts",
  { skip: process.env.CAT_TEST_REAL !== "1", timeout: 330000 },
  async () => {
    const home = mkdtempSync("/tmp/cat-real-team-");
    chmodSync(home, 0o700);
    const auth = join(home, "auth.json");
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      auth,
    );
    chmodSync(auth, 0o600);
    writeFileSync(
      join(home, "config.toml"),
      "[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n",
    );
    const options = {
      stateDirectory: join(home, "team"),
      runtimeHome: home,
      expectedVersion: "codex-cli 0.162.0-alpha.17.2",
    };
    const coordinator = new Coordinator(options);
    const evidence: Record<string, unknown> = {
      mode: "real-model-persistent-coordinator",
      home,
      expectedVersion: options.expectedVersion,
      startedAt: new Date().toISOString(),
    };
    try {
      await coordinator.start();
      const root = coordinator.createRoot("A", recursiveTask, {
        tokens: 200000,
        maxDepth: 2,
        maxAgents: 3,
        maxConcurrentTurns: 3,
        maxTurnsPerAgent: 4,
        turnReservation: 5000,
      });
      evidence.rootId = root.id;
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        const attempts = coordinator.store.attempts(root.id);
        if (
          attempts.length === 2 &&
          attempts.every((a) => a.state === "completed") &&
          attempts.some((a) =>
            /FINAL_ROOT_RESULT[\s\S]*\b42\b/.test(a.result ?? ""),
          ) &&
          coordinator.store.agents(root.tree_id).length === 3 &&
          coordinator.store.attempts().every((a) => a.state === "completed")
        )
          break;
        if (coordinator.diagnostics().errors.length > 0)
          throw new Error(
            "Coordinator reported an error; see captured diagnostics",
          );
        await delay(200);
      }
      const agents = coordinator.store.agents(root.tree_id);
      evidence.agents = agents.map((a) => coordinator.status(a.id));
      evidence.diagnostics = coordinator.diagnostics();
      assert.equal(agents.length, 3);
      assert.ok(
        coordinator.store.attempts().every((a) => a.state === "completed"),
      );
      const b = agents.find((a) => a.parent_id === root.id);
      assert.ok(b);
      const c = agents.find((a) => a.parent_id === b.id);
      assert.ok(c);
      assert.equal(
        new Set(agents.map((a) => coordinator.store.binding(a.id)?.thread_id))
          .size,
        3,
      );
      const rootTurns = coordinator.store.attempts(root.id);
      assert.equal(rootTurns.length, 2);
      assert.equal(coordinator.store.attempts(b.id).length, 2);
      assert.equal(coordinator.store.attempts(c.id).length, 1);
      assert.ok(
        rootTurns.some(
          (a) =>
            a.state === "completed" &&
            (a as unknown as { result: string }).result.includes(
              "FINAL_ROOT_RESULT",
            ),
        ),
      );
      for (const a of [root, b]) {
        const messages = coordinator.store.messages(a.id);
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.status, "processed");
      }
      assert.equal(coordinator.store.messages(b.id)[0]?.sender_id, c.id);
      assert.equal(coordinator.store.messages(root.id)[0]?.sender_id, b.id);
      assert.match(coordinator.store.messages(b.id)[0]!.body, /\b42\b/);
      assert.match(coordinator.store.messages(root.id)[0]!.body, /\b42\b/);
      assert.ok(
        rootTurns.some((a) =>
          /FINAL_ROOT_RESULT[\s\S]*\b42\b/.test(
            String((a as unknown as { result: string }).result),
          ),
        ),
      );
      const events = agents.flatMap((a) => coordinator.store.events(a.id));
      evidence.events = events;
      assert.equal(events.filter((e) => e.kind === "spawn.accepted").length, 2);
      assert.equal(events.filter((e) => e.kind === "tool.rejected").length, 0);
      await coordinator.stop();
      const reopened = new Store(
        join(options.stateDirectory, "business.sqlite"),
      );
      try {
        assert.equal(reopened.agents(root.tree_id).length, 3);
        assert.equal(reopened.messages(root.id)[0]?.status, "processed");
        assert.equal(
          reopened.binding(c.id)?.thread_id,
          (
            evidence.agents as Array<{
              id: string;
              binding: { thread_id: string };
            }>
          ).find((a) => a.id === c.id)?.binding.thread_id,
        );
      } finally {
        reopened.close();
      }
      evidence.passed = true;
    } catch (error) {
      evidence.passed = false;
      evidence.error = String(error);
      evidence.diagnostics = coordinator.diagnostics();
      evidence.snapshots = coordinator.store
        .agents()
        .map((a) => coordinator.status(a.id));
      throw error;
    } finally {
      await coordinator.stop();
      try {
        await execute("codex", ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
        });
      } finally {
        unlinkSync(auth);
        evidence.finishedAt = new Date().toISOString();
        writeEvidence("persistent-real-e2e.json", evidence);
      }
    }
  },
);
