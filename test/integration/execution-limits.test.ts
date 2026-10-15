import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store, type TreeLimits } from "../../src/storage/store.ts";
import { spawnInput } from "../../src/tools/inputs.ts";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";
const limits: TreeLimits = {
  tokens: 1,
  maxDepth: 2,
  maxAgents: 4,
  maxConcurrentTurns: 3,
  maxTurnsPerAgent: 4,
  maxTotalTurns: 8,
  turnReservation: 100,
};
function fixture() {
  const directory = mkdtempSync("/tmp/cat-execution-");
  const path = join(directory, "business.sqlite");
  let store = new Store(path);
  return {
    directory,
    path,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(path);
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function run(store: Store, id: string) {
  const binding =
    store.binding(id) ?? store.bind(id, `thread-${id}`, "fixture");
  const attempt = store.prepare(id, "work");
  store.markStarting(attempt.id);
  store.attachTurn(attempt.id, binding.generation, `turn-${attempt.id}`);
  return {
    attempt,
    actor: store.authenticate(
      binding.thread_id,
      `turn-${attempt.id}`,
      binding.generation,
    ),
  };
}
const work = { name: "B", role: "worker", task: "supplied text" };

test("new trees observe tokens by default: no child allocation, no admission block, durable actual-usage warning", () => {
  const f = fixture();
  try {
    const root = f.store.createRoot("A", "work", limits);
    const a = run(f.store, root.id);
    assert.equal(f.store.limits(root.tree_id).tokenPolicy, "observe");
    assert.equal(f.store.budgetStatus(root.tree_id).warningExceeded, false); // Reservation alone isn't usage.
    const child = f.store.spawn(
      a.actor,
      "child",
      spawnInput({ requestKey: "child", ...work }),
    );
    assert.equal(f.store.agent(root.id).capacity, 1);
    assert.equal(child.capacity, 0);
    run(f.store, child.id);
    f.store.observeNativeUsage(a.attempt.id, 1, 200);
    f.store.observeNativeUsage(a.attempt.id, 1, 200);
    f.store.finish(a.attempt.id, 1, "completed", "done");
    f.reopen();
    const budget = f.store.budgetStatus(root.tree_id);
    assert.equal(budget.enforced, false);
    assert.equal(budget.observedTokens, 200);
    assert.equal(budget.warningExceeded, true);
    assert.equal(
      f.store
        .events(root.id)
        .filter((e) => e.kind === "usage.threshold_exceeded").length,
      1,
    );
    const next = run(f.store, root.id);
    f.store.observeNativeUsage(next.attempt.id, 1, 250);
    assert.equal(f.store.budgetStatus(root.tree_id).observedTokens, 250);
    assert.equal(
      f.store
        .events(root.id)
        .filter((e) => e.kind === "usage.threshold_exceeded").length,
      1,
    );
  } finally {
    f.close();
  }
});

test("explicit enforce mode retains parent allocation and token admission gates", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.store.createRoot("bad", "work", {
          ...limits,
          tokenPolicy: "enforce",
        }),
      /reservation exceeds/i,
    );
    const root = f.store.createRoot("A", "work", {
      ...limits,
      tokenPolicy: "enforce",
      tokens: 1000,
    });
    const a = run(f.store, root.id);
    assert.throws(
      () => f.store.spawn(a.actor, "missing", work),
      /allocate child/,
    );
    const child = f.store.spawn(a.actor, "child", { ...work, tokens: 200 });
    assert.equal(child.capacity, 200);
    assert.equal(f.store.agent(root.id).capacity, 800);
    f.store.observeNativeUsage(a.attempt.id, 1, 1100);
    f.store.finish(a.attempt.id, 1, "completed", "done");
    assert.throws(() => run(f.store, root.id), /Global tree budget/);
    assert.equal(f.store.budgetStatus(root.tree_id).enforced, true);
  } finally {
    f.close();
  }
});

test("tree lifetime Turn count survives cancellation and restart, including prepared Turns and idempotent spawn replay", () => {
  const f = fixture();
  try {
    const root = f.store.createRoot("A", "work", {
      ...limits,
      maxTotalTurns: 2,
    });
    const a = run(f.store, root.id);
    const child = f.store.spawn(a.actor, "child", work);
    f.store.bind(child.id, `thread-${child.id}`, "fixture");
    const prepared = f.store.prepare(child.id, "unsent");
    assert.equal(f.store.executionStatus(root.tree_id).remainingTurns, 0);
    assert.equal(f.store.spawn(a.actor, "child", work).id, child.id);
    assert.throws(
      () => f.store.spawn(a.actor, "another", work),
      /Tree lifetime Turn limit/,
    );
    f.store.control(null, child.id, "cancel", "agent");
    assert.notEqual(f.store.attempt(prepared.id).state, "prepared");
    f.store.observeNativeUsage(a.attempt.id, 1, 10);
    f.store.finish(a.attempt.id, 1, "failed", "failure");
    f.reopen();
    assert.equal(f.store.executionStatus(root.tree_id).usedTurns, 2);
    assert.throws(() => run(f.store, root.id), /lifetime Turn limit/);
  } finally {
    f.close();
  }
});

test("observe mode still enforces depth, lifetime Agent count, concurrency and per-Agent Turns", () => {
  const f = fixture();
  try {
    const root = f.store.createRoot("A", "work", {
      ...limits,
      maxDepth: 1,
      maxAgents: 2,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 1,
    });
    const a = run(f.store, root.id);
    const child = f.store.spawn(a.actor, "child", work);
    assert.throws(
      () => f.store.spawn(a.actor, "extra", work),
      /lifetime Agent/,
    );
    assert.throws(() => run(f.store, child.id), /Concurrent Turn/);
    f.store.observeNativeUsage(a.attempt.id, 1, 10);
    f.store.finish(a.attempt.id, 1, "completed", "done");
    assert.throws(() => run(f.store, root.id), /lifetime Turn limit/);
    assert.ok(f.store.executionStatus(root.tree_id).remainingTurns > 0);
    const b = run(f.store, child.id);
    assert.throws(
      () => f.store.spawn(b.actor, "too-deep", work),
      /Depth or lifetime/,
    );
  } finally {
    f.close();
  }
});

test("unknown execution keeps its own fence and concurrent slot while unknown usage is advisory in observe mode", () => {
  const f = fixture();
  try {
    const root = f.store.createRoot("A", "work", {
      ...limits,
      maxConcurrentTurns: 2,
    });
    const a = run(f.store, root.id);
    const child = f.store.spawn(a.actor, "child", work);
    f.store.uncertain(a.attempt.id, "reply lost");
    assert.throws(() => run(f.store, root.id), /live or uncertain/);
    const b = run(f.store, child.id);
    f.store.finish(b.attempt.id, 1, "interrupted", "no final usage");
    assert.ok(
      f.store
        .budgetStatus(root.tree_id)
        .unknownUsageAttempts.includes(b.attempt.id),
    );
    run(f.store, child.id);
    assert.equal(f.store.attempt(a.attempt.id).state, "unknown");
  } finally {
    f.close();
  }
});

test("legacy schema 5 trees retain enforcement and derived lifetime bounds without changing native identity", () => {
  const f = fixture();
  try {
    const legacy = {
      tokens: 1000,
      maxDepth: 2,
      maxAgents: 3,
      maxConcurrentTurns: 2,
      maxTurnsPerAgent: 4,
      turnReservation: 100,
    };
    const root = f.store.createRoot("A", "work", legacy, "original");
    const a = run(f.store, root.id);
    f.store.db
      .prepare("UPDATE trees SET limits_json=? WHERE id=?")
      .run(JSON.stringify(legacy), root.tree_id);
    f.store.db.exec("UPDATE schema_version SET version=5");
    f.reopen();
    assert.equal(f.store.limits(root.tree_id).tokenPolicy, "enforce");
    assert.equal(f.store.limits(root.tree_id).maxTotalTurns, 12);
    assert.equal(
      f.store.createRoot("A", "work", legacy, "original").id,
      root.id,
    );
    assert.equal(f.store.attempt(a.attempt.id).turn_id, a.actor.turnId);
    assert.equal(
      f.store.db.prepare("SELECT version FROM schema_version").get()?.version,
      6,
    );
    assert.equal(f.store.executionStatus(root.tree_id).usedTurns, 1);
  } finally {
    f.close();
  }
});

test("spawn input cannot change tree policy or execution limits; omitted token hints are valid", () => {
  assert.equal(spawnInput({ requestKey: "one", ...work }).tokens, undefined);
  for (const key of ["tokenPolicy", "maxTotalTurns", "maxAgents", "maxDepth"])
    assert.throws(
      () => spawnInput({ requestKey: "one", ...work, [key]: "observe" }),
      /Unknown argument/,
    );
});

test("coordinator view and wait allow low-threshold work but explain tree Turn exhaustion", async () => {
  const directory = mkdtempSync("/tmp/cat-execution-view-");
  const runtime = new ControlledRuntime();
  const coordinator = new Coordinator(
    {
      stateDirectory: directory,
      runtimeHome: join(directory, "native"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
  };
  try {
    await coordinator.start();
    const root = coordinator.createRoot("A", "work", {
      ...limits,
      maxTotalTurns: 2,
    });
    await settle();
    runtime.complete();
    await settle();
    coordinator.submitInput(root.id, "again", "another turn");
    await settle();
    assert.equal(runtime.starts.length, 2);
    assert.equal(coordinator.view(root.id).progressPossible, true);
    runtime.complete(1);
    await settle();
    coordinator.submitInput(root.id, "blocked", "third turn");
    await settle();
    const view = coordinator.view(root.id);
    assert.equal(view.progressPossible, false);
    assert.equal(view.executionLimits.usedTurns, 2);
    assert.equal(view.budget.enforced, false);
    assert.ok(view.reasons.some((r) => r.code === "tree-turn-limit"));
    assert.ok(!view.reasons.some((r) => r.code === "tree-budget"));
    assert.equal(
      (await coordinator.wait(root.id, view.cursor, 0)).reason,
      "noProgress",
    );
  } finally {
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
