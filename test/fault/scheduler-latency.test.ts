import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";
async function gate(p: () => boolean) {
  for (let i = 0; i < 500 && !p(); i++)
    await new Promise<void>((r) => setImmediate(r));
  assert.ok(p());
}
for (const delay of [0, 40, 120])
  test(`incremental scheduler qualification: first metadata RPC held ${delay} ms, no duplicate dispatch`, async () => {
    const dir = mkdtempSync("/tmp/cat-rpc-latency-"),
      runtime = new ControlledRuntime();
    const read = runtime.readThread.bind(runtime);
    let release!: () => void,
      entered = false;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    runtime.readThread = async (id) => {
      if (id === "thread-1" && !entered) {
        entered = true;
        await barrier;
      }
      return read(id);
    };
    const c = new Coordinator(
      {
        stateDirectory: dir,
        runtimeHome: join(dir, "h"),
        expectedVersion: "fixture",
      },
      runtime,
    );
    try {
      await c.start();
      const limits = {
        tokenPolicy: "observe" as const,
        tokens: 1000,
        maxDepth: 0,
        maxAgents: 1,
        maxConcurrentTurns: 2,
        maxTurnsPerAgent: 2,
        turnReservation: 100,
      };
      c.createRoot("A", "first", limits);
      await gate(() => entered);
      const waiting = performance.now();
      c.createRoot("B", "second", limits);
      await gate(() => runtime.starts.length === 1);
      await new Promise<void>((r) => setTimeout(r, delay));
      assert.equal(runtime.starts[0]!.threadId, "thread-2");
      release();
      await gate(() => runtime.starts.length === 2);
      assert.ok(performance.now() - waiting >= Math.max(0, delay - 2));
      assert.equal(new Set(runtime.starts.map((s) => s.attemptId)).size, 2);
      assert.equal(new Set(runtime.starts.map((s) => s.threadId)).size, 2);
    } finally {
      release();
      await c.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
