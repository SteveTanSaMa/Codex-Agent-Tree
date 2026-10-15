import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { writeEvidence } from "../fixtures/evidence.ts";
const execute = promisify(execFile);
test(
  "third-party provider: official CLI initialization and detached credential loading complete a two-agent report",
  { skip: process.env.CAT_TEST_PROVIDER_REAL !== "1", timeout: 180000 },
  async () => {
    const source = process.env.CAT_PROVIDER_CONFIG;
    const envKey = process.env.CAT_PROVIDER_ENV;
    const executable = process.env.CAT_PROVIDER_EXECUTABLE;
    assert.ok(
      source && envKey && executable,
      "Set CAT_PROVIDER_CONFIG, CAT_PROVIDER_ENV and CAT_PROVIDER_EXECUTABLE explicitly",
    );
    const before = readFileSync(source);
    const base = mkdtempSync("/tmp/cat-prov-");
    chmodSync(base, 0o700);
    const state = join(base, "s"),
      home = join(base, "h");
    const evidence: Record<string, unknown> = {
      mode: "real-provider-public-cli",
      temporaryWrapper: false,
    };
    const cli = async (command: string, ...args: string[]) => {
      const pending = execute(
        process.execPath,
        ["scripts/cat.mjs", command, "--state", state, ...args],
        { timeout: 40000, maxBuffer: 1024 * 1024 },
      );
      pending.child.stdin?.end();
      return JSON.parse((await pending).stdout);
    };
    let stopped = false;
    try {
      const service = process.env.CAT_PROVIDER_KEYCHAIN_SERVICE;
      await cli(
        "init",
        "--runtime-home",
        home,
        "--config-from",
        source,
        "--provider-env",
        envKey,
        "--executable",
        executable,
        ...(service ? ["--keychain-service", service] : []),
      );
      assert.ok((await cli("doctor")).ok);
      await cli("start");
      const root = await cli(
        "root",
        "--task",
        "Initially spawn child B exactly once, role calculator. Child task: Calculate 7 times 6, send CHILD_RESULT 42 to your parent with agent_send, and end your Turn. Omit child tokens. End your initial Turn immediately after spawning. Upon receiving a child message, acknowledge its ID with agent_ack and output exactly FIXED_PROVIDER_OK 42. Never spawn again.",
        "--max-depth",
        "1",
        "--max-agents",
        "2",
        "--concurrent",
        "2",
        "--max-turns",
        "2",
        "--max-total-turns",
        "3",
      );
      const deadline = Date.now() + 100000;
      let complete = false;
      while (Date.now() < deadline) {
        const agents = (await cli("tree")).filter(
          (a: { tree_id: string }) => a.tree_id === root.tree_id,
        );
        const statuses = await Promise.all(
          agents.map((a: { id: string }) => cli("status", "--target", a.id)),
        );
        const parent = statuses.find((a) => a.id === root.id);
        if (
          agents.length === 2 &&
          statuses.every(
            (a) =>
              a.attempts.length > 0 &&
              a.attempts.every(
                (t: { state: string }) => t.state === "completed",
              ),
          ) &&
          parent.messages.some(
            (m: { status: string }) => m.status === "processed",
          ) &&
          parent.attempts.some((t: { result: string }) =>
            /FIXED_PROVIDER_OK 42/.test(t.result ?? ""),
          )
        ) {
          assert.equal(
            new Set(statuses.map((a) => a.binding.thread_id)).size,
            2,
          );
          assert.equal(
            statuses.reduce((n, a) => n + a.attempts.length, 0),
            3,
          );
          assert.equal(parent.budget.reserved, 0);
          evidence.agents = statuses.map((a) => ({
            id: a.id,
            thread: a.binding.thread_id,
            attempts: a.attempts.map(
              (t: { state: string; result: string }) => ({
                state: t.state,
                result: t.result,
              }),
            ),
            budget: a.budget,
          }));
          complete = true;
          break;
        }
        await delay(250);
      }
      assert.ok(
        complete,
        "All three native Turns and the receipt must complete",
      );
      evidence.passed = true;
    } catch (error) {
      evidence.passed = false;
      evidence.error = String(error);
      throw error;
    } finally {
      try {
        await cli("stop");
      } catch {
        /* init/start failure may leave no control server */
      }
      try {
        await execute(executable, ["app-server", "daemon", "stop"], {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CODEX_HOME: home,
          },
          timeout: 30000,
        });
        stopped = true;
      } finally {
        evidence.sourceConfigUnchanged = readFileSync(source).equals(before);
        assert.equal(evidence.sourceConfigUnchanged, true);
        evidence.daemonStopped = stopped;
        writeEvidence("provider-public-cli.json", evidence);
        if (stopped) rmSync(base, { recursive: true, force: true });
      }
    }
  },
);
