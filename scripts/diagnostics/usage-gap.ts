// Regression diagnostic: a missing final native sample must not overlap a human receipt.
import assert from "node:assert/strict";
import { Store } from "../../src/storage/store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync("/tmp/cat-ledger-gap-");
const s = new Store(join(dir, "s.sqlite"));
try {
  const root = s.createRoot("A", "work", {
    tokenPolicy: "enforce",
    tokens: 1000,
    maxDepth: 0,
    maxAgents: 1,
    maxConcurrentTurns: 1,
    maxTurnsPerAgent: 4,
    turnReservation: 100,
  });
  s.bind(root.id, "thread-a", "test");
  const run = () => {
    const a = s.prepare(root.id, "work");
    s.markStarting(a.id);
    s.attachTurn(a.id, 1, "turn-" + a.id);
    return a;
  };
  const a = run();
  s.observeNativeUsage(a.id, 1, 30);
  s.finish(a.id, 1, "interrupted", "stopped");
  s.settleFinalUsage(a.id, 1, 50, "verified final receipt");
  const b = run();
  s.observeNativeUsage(b.id, 1, 75);
  s.finish(b.id, 1, "completed", "done");
  console.log(
    JSON.stringify({
      nativeThreadTotal: 75,
      firstAttestedFinal: 50,
      expectedSecond: 25,
      actualSecond: s.attempt(b.id).observed,
      actualTreeSpent: s.agent(root.id).spent,
      budget: s.budgetStatus(root.tree_id),
    }),
  );
  assert.equal(
    s.agent(root.id).spent,
    75,
    "Human receipt must not be counted again in the next native delta",
  );
} finally {
  s.close();
  rmSync(dir, { recursive: true, force: true });
}
