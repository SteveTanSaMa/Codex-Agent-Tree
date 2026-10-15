import { writeEvidence } from "../fixtures/evidence.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  chmodSync,
  copyFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import {
  CodexRuntime,
  record,
  runtimeEnvironment,
} from "../../src/runtime/codex/adapter.ts";

class LoseAcceptedReply extends CodexRuntime {
  starts = 0;
  acceptedTurn: string | undefined;
  override async startTurn(
    threadId: string,
    input: string,
    attemptId: string,
  ): Promise<string> {
    this.starts++;
    assert.equal(
      this.starts,
      1,
      "Lost response must not cause another native start",
    );
    this.acceptedTurn = await super.startTurn(threadId, input, attemptId);
    // The real server has accepted the Turn. Suppress the caller's reply and
    // sever its subscription, while the independently owned daemon stays alive.
    this.disconnect();
    this.onDisconnect(new Error("injected accepted reply loss"));
    throw new Error("injected accepted reply loss");
  }
}

test(
  "real accepted start reply loss: reconnect reconciles the original Turn without resubmitting",
  { skip: process.env.CAT_TEST_REAL !== "1", timeout: 150000 },
  async () => {
    const home = mkdtempSync("/tmp/cat-real-ack-");
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
    const runtime = new LoseAcceptedReply({
      home,
      expectedVersion: options.expectedVersion,
    });
    let coordinator = new Coordinator(options, runtime);
    const evidence: Record<string, unknown> = {
      mode: "real-model-accepted-ACK-loss",
      fault:
        "real native acceptance followed by synthetic caller reply/subscription loss",
      home,
      startedAt: new Date().toISOString(),
    };
    try {
      await coordinator.start();
      const root = coordinator.createRoot(
        "A",
        "Do not use tools. Calculate 7 times 6 and output ACK_RECOVERED followed by the answer.",
        {
          tokens: 50000,
          maxDepth: 0,
          maxAgents: 1,
          maxConcurrentTurns: 1,
          maxTurnsPerAgent: 2,
          turnReservation: 5000,
        },
      );
      let deadline = Date.now() + 60000;
      while (!runtime.acceptedTurn && Date.now() < deadline) await delay(50);
      assert.ok(runtime.acceptedTurn, "Real native ACK was not observed");
      // Wait for the explicit disconnection failure to be durably recorded.
      while (
        Date.now() < deadline &&
        coordinator.store.attempts(root.id)[0]?.state !== "unknown"
      )
        await delay(20);
      evidence.beforeRestart = coordinator.status(root.id);
      const original = coordinator.store.attempts(root.id)[0]!;
      assert.equal(original.state, "unknown");
      await coordinator.stop();
      coordinator = new Coordinator(options);
      await coordinator.start();
      deadline = Date.now() + 60000;
      while (
        coordinator.store.attempt(original.id).state !== "completed" &&
        Date.now() < deadline
      )
        await delay(100);
      const final = coordinator.store.attempt(original.id);
      assert.equal(final.state, "completed");
      assert.equal(final.turn_id, runtime.acceptedTurn);
      assert.equal(coordinator.store.runtimeBlock(root.id), undefined);
      assert.equal(coordinator.store.attempts(root.id).length, 1);
      assert.equal(runtime.starts, 1);
      assert.match(final.result ?? "", /ACK_RECOVERED[\s\S]*42/);
      const history = await coordinator.nativeHistory(root.id);
      const turns = record(history.thread).turns;
      assert.ok(Array.isArray(turns));
      assert.equal(turns.length, 1);
      assert.equal(record(turns[0]).id, runtime.acceptedTurn);
      evidence.afterRestart = coordinator.status(root.id);
      evidence.nativeHistory = history;
      evidence.events = coordinator.store.events(root.id);
      evidence.acceptedNativeStarts = runtime.starts;
      evidence.passed = true;
    } catch (error) {
      evidence.passed = false;
      evidence.error = String(error);
      evidence.diagnostics = coordinator.diagnostics();
      throw error;
    } finally {
      await coordinator.stop();
      try {
        await promisify(execFile)("codex", ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
        });
      } finally {
        unlinkSync(auth);
        evidence.finishedAt = new Date().toISOString();
        writeEvidence("real-ack-loss.json", evidence);
      }
    }
  },
);
