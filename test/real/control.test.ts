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
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);

test(
  "real native Turn cancellation and termination preserve Thread identity and observe interrupted status",
  { skip: process.env.CAT_TEST_REAL !== "1", timeout: 150000 },
  async () => {
    const home = mkdtempSync("/tmp/cat-real-control-");
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
    const coordinator = new Coordinator({
      stateDirectory: join(home, "team"),
      runtimeHome: home,
      expectedVersion: "codex-cli 0.162.0-alpha.17.2",
    });
    const evidence: Record<string, unknown> = {
      mode: "actual-native-turn-control",
      home,
      cases: [],
      startedAt: new Date().toISOString(),
    };
    try {
      await coordinator.start();
      for (const action of ["cancel", "terminate"] as const) {
        const root = coordinator.createRoot(
          `control-${action}`,
          "Call agent_status eight times sequentially, once per tool result. Do not spawn, send messages or run commands. After those calls, say CONTROL_SEQUENCE_DONE.",
          {
            tokens: 200000,
            maxDepth: 1,
            maxAgents: 2,
            maxConcurrentTurns: 2,
            maxTurnsPerAgent: 4,
            turnReservation: 5000,
          },
        );
        const deadline = Date.now() + 45000;
        let running: ReturnType<typeof coordinator.store.attempt> | undefined;
        while (Date.now() < deadline) {
          running = coordinator.store
            .attempts(root.id)
            .find((a) => a.state === "running" && a.turn_id);
          if (running) break;
          await delay(20);
        }
        assert.ok(
          running?.turn_id,
          "A real native Turn must be running before control",
        );
        const thread = coordinator.store.binding(root.id)!.thread_id;
        await coordinator.control(root.id, action);
        const end = Date.now() + 20000;
        while (
          Date.now() < end &&
          !["completed", "failed", "interrupted"].includes(
            coordinator.store.attempt(running.id).state,
          )
        )
          await delay(50);
        const final = coordinator.store.attempt(running.id);
        assert.equal(final.state, "interrupted");
        assert.equal(
          coordinator.store.agent(root.id).desired,
          action === "cancel" ? "cancelled" : "terminated",
        );
        assert.equal(coordinator.store.binding(root.id)?.thread_id, thread);
        assert.equal(
          coordinator.store
            .events(root.id)
            .filter((e) => e.kind === "turn.interrupt_requested").length,
          1,
        );
        let history: Record<string, unknown> | undefined;
        const visible = Date.now() + 10000;
        while (Date.now() < visible) {
          history = await coordinator.nativeHistory(root.id);
          const turns = (
            history.thread as { turns: Array<{ id: string; status: string }> }
          ).turns;
          if (
            turns.some(
              (t) => t.id === running!.turn_id && t.status === "interrupted",
            )
          )
            break;
          await delay(100);
        }
        assert.ok(
          (
            history!.thread as { turns: Array<{ id: string; status: string }> }
          ).turns.some(
            (t) => t.id === running!.turn_id && t.status === "interrupted",
          ),
        );
        (evidence.cases as unknown[]).push({
          action,
          status: coordinator.status(root.id),
          history,
        });
      }
      evidence.passed = true;
    } catch (error) {
      evidence.passed = false;
      evidence.error = String(error);
      evidence.diagnostics = coordinator.diagnostics();
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
        writeEvidence("real-control.json", evidence);
      }
    }
  },
);
