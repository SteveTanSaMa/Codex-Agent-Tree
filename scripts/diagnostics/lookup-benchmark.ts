import assert from "node:assert/strict";
import { Store } from "../../src/storage/store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync("/tmp/cat-lookup-bench-");
const store = new Store(join(dir, "state.sqlite"));
try {
  const root = store.createRoot("A", "work", {
    tokens: 1000,
    maxDepth: 1,
    maxAgents: 2,
    maxConcurrentTurns: 1,
    maxTurnsPerAgent: 10000,
    turnReservation: 100,
  });
  const statement = store.db.prepare(
    "INSERT INTO turn_attempts(id,agent_id,thread_id,binding_generation,owner_generation,turn_id,state,input,trace_id,reserved,created_at) VALUES(?,?,?,1,1,?,'completed',?,?,0,'2026-10-15')",
  );
  store.db.exec("BEGIN");
  for (let i = 0; i < 5000; i++)
    statement.run(
      "attempt-" + i,
      root.id,
      "thread-a",
      "turn-" + i,
      "x".repeat(2000),
      "trace",
    );
  store.db.exec("COMMIT");
  assert.deepEqual(
    store.attemptForTurn("thread-a", "turn-4999"),
    store
      .attempts()
      .find((a) => a.thread_id === "thread-a" && a.turn_id === "turn-4999"),
  );
  const bench = (fn: () => unknown) => {
    const samples: number[] = [];
    for (let i = 0; i < 25; i++) {
      const a = performance.now();
      fn();
      samples.push(performance.now() - a);
    }
    return samples.sort((a, b) => a - b)[12];
  };
  console.log(
    JSON.stringify({
      rows: 5000,
      inputChars: 2000,
      scanMedianMs: bench(() =>
        store
          .attempts()
          .find((a) => a.thread_id === "thread-a" && a.turn_id === "turn-4999"),
      ),
      indexMedianMs: bench(() => store.attemptForTurn("thread-a", "turn-4999")),
      plan: store.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM turn_attempts WHERE thread_id=? AND turn_id=?",
        )
        .all("thread-a", "turn-4999"),
    }),
  );
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
