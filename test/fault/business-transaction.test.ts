import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/storage/store.ts";

test("mid-spawn storage failure rolls back allocation, identity, idempotency key and acceptance trace together", () => {
  const dir = mkdtempSync("/tmp/cat-atomic-spawn-");
  const path = join(dir, "business.sqlite");
  const store = new Store(path);
  const injector = new DatabaseSync(path);
  try {
    const root = store.createRoot("A", "delegate", {
      tokens: 10000,
      maxDepth: 2,
      maxAgents: 3,
      maxConcurrentTurns: 3,
      maxTurnsPerAgent: 4,
      turnReservation: 100,
    });
    store.bind(root.id, "fixture-thread", "test");
    const attempt = store.prepare(root.id, "delegate");
    store.markStarting(attempt.id);
    store.attachTurn(attempt.id, 1, "fixture-turn");
    const actor = store.authenticate("fixture-thread", "fixture-turn", 1);
    const before = store.agent(root.id);
    injector.exec(
      "CREATE TRIGGER fail_child AFTER INSERT ON agents WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected child persistence failure'); END",
    );
    const input = { name: "B", role: "worker", task: "work", tokens: 1000 };
    assert.throws(
      () => store.spawn(actor, "same-key", input),
      /injected child persistence failure/,
    );
    assert.equal(store.agent(root.id).capacity, before.capacity);
    assert.equal(store.agent(root.id).reserved, before.reserved);
    assert.equal(store.agents().length, 1);
    assert.equal(
      injector
        .prepare(
          "SELECT COUNT(*) AS n FROM operations WHERE operation_key='same-key'",
        )
        .get()?.n,
      0,
    );
    assert.equal(
      injector
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind='spawn.accepted'")
        .get()?.n,
      0,
    );
    injector.exec("DROP TRIGGER fail_child");
    const child = store.spawn(actor, "same-key", input);
    assert.equal(store.spawn(actor, "same-key", input).id, child.id);
    assert.equal(store.agent(root.id).capacity, before.capacity - 1000);
  } finally {
    injector.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
