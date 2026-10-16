import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
function fixture() {
  const dir = mkdtempSync("/tmp/cat-reminders-");
  const path = join(dir, "business.sqlite");
  let store = new Store(path);
  const root = store.createRoot(
    "A",
    "work",
    rootSettings({ tokenAlertAt: 100 }).limits,
  );
  const run = (id: string) => {
    const b = store.binding(id) ?? store.bind(id, `thread-${id}`, "fixture");
    const t = store.prepare(id, "work");
    store.markStarting(t.id);
    store.attachTurn(t.id, b.generation, `turn-${t.id}`);
    return store.attempt(t.id);
  };
  const turn = run(root.id);
  return {
    dir,
    path,
    root,
    turn,
    run,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(path);
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function breakdown(input: number, cached: number, output: number) {
  return {
    total: {
      totalTokens: input + output,
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      reasoningOutputTokens: 0,
    },
    last: {},
  };
}
const alerts = (s: Store, id: string) =>
  s
    .events(id)
    .filter((e) => e.kind === "usage.reminder")
    .map((e) => JSON.parse(String(e.body)));
test("single reminder fires at equality, survives restart and never imposes per-Agent admission", () => {
  const f = fixture();
  try {
    f.store.observeNativeUsage(f.turn.id, 1, 99);
    assert.equal(alerts(f.store, f.root.id).length, 0);
    f.store.observeNativeUsage(f.turn.id, 1, 100);
    assert.equal(alerts(f.store, f.root.id).length, 1);
    f.reopen();
    f.store.observeNativeUsage(f.turn.id, 1, 100);
    f.store.observeNativeUsage(f.turn.id, 1, 90);
    f.store.observeNativeUsage(f.turn.id, 1, 10000);
    assert.equal(alerts(f.store, f.root.id).length, 1);
    assert.equal(f.store.agent(f.root.id).capacity, 0);
    assert.equal(f.store.budgetStatus(f.root.tree_id).availableTokens, null);
    f.store.finish(f.turn.id, 1, "completed", "done");
    assert.ok(f.run(f.root.id));
    assert.equal(f.store.agent(f.root.id).desired, "active");
    assert.throws(() => rootSettings({ tokenPolicy: "enforce" }), /per-Agent/);
    assert.throws(() => rootSettings({ tokenAlertEvery: 0 }), /Invalid/);
    assert.throws(() => rootSettings({ tokenAlertMetric: "cost" }), /metric/);
  } finally {
    f.close();
  }
});
test("interval crossings coalesce and preserve cursor over retries, restart and disabled policies", () => {
  const f = fixture();
  try {
    const p = { metric: "total", thresholdTokens: 100, repeatEveryTokens: 50 };
    f.store.reminders.configure(f.root.id, "tree", p);
    f.store.observeNativeUsage(f.turn.id, 1, 260);
    assert.deepEqual(
      alerts(f.store, f.root.id).map((a) => [
        a.firstThreshold,
        a.lastThreshold,
        a.crossedCount,
      ]),
      [[100, 250, 4]],
    );
    f.store.reminders.configure(f.root.id, "tree", p);
    assert.equal(alerts(f.store, f.root.id).length, 1);
    f.reopen();
    f.store.observeNativeUsage(f.turn.id, 1, 290);
    assert.equal(alerts(f.store, f.root.id).length, 1);
    f.store.observeNativeUsage(f.turn.id, 1, 300);
    assert.equal(alerts(f.store, f.root.id)[1].lastThreshold, 300);
    assert.throws(
      () =>
        f.store.reminders.configure(f.root.id, "tree", {
          ...p,
          repeatEveryTokens: 0,
        }),
      /Invalid/,
    );
    assert.equal(
      f.store.reminders.summary(f.root.id, "tree").nextThreshold,
      350,
    );
    f.store.reminders.configure(f.root.id, "tree", null);
    f.store.observeNativeUsage(f.turn.id, 1, 1000);
    assert.equal(alerts(f.store, f.root.id).length, 2);
    assert.equal(f.store.budgetStatus(f.root.tree_id).warningExceeded, false);
  } finally {
    f.close();
  }
});
test("agent and tree reminders use distinct metrics without counting cached input twice", () => {
  const f = fixture();
  try {
    const actor = f.store.authenticate(f.turn.thread_id, f.turn.turn_id!, 1);
    const child = f.store.spawn(actor, "child", {
      name: "B",
      role: "worker",
      task: "work",
    });
    const t = f.run(child.id);
    f.store.reminders.configure(f.root.id, "tree", {
      metric: "uncachedInput",
      thresholdTokens: 40,
      repeatEveryTokens: 20,
    });
    f.store.reminders.configure(child.id, "agent", {
      metric: "output",
      thresholdTokens: 10,
    });
    f.store.observeNativeUsage(f.turn.id, 1, 100, breakdown(80, 40, 20));
    f.store.observeNativeUsage(t.id, 1, 100, breakdown(90, 50, 10));
    const tree = f.store.reminders.summary(f.root.id, "tree");
    assert.equal(tree.metrics.totalTokens, 200);
    assert.equal(tree.metrics.cachedInputTokens, 90);
    assert.equal(tree.metrics.uncachedInputTokens, 80);
    assert.equal(tree.metrics.outputTokens, 30);
    assert.equal(alerts(f.store, child.id).length, 1);
    assert.equal(alerts(f.store, child.id)[0].metric, "output");
    assert.deepEqual(
      alerts(f.store, f.root.id).map((a) => a.lastThreshold),
      [40, 80],
    );
  } finally {
    f.close();
  }
});
test("missing breakdown stays unknown, later valid evidence enables a metric without duplicate totals", () => {
  const f = fixture();
  try {
    f.store.reminders.configure(f.root.id, "tree", {
      metric: "output",
      thresholdTokens: 10,
    });
    f.store.observeNativeUsage(f.turn.id, 1, 100);
    assert.equal(
      f.store.reminders.summary(f.root.id, "tree").metricAvailable,
      false,
    );
    assert.equal(alerts(f.store, f.root.id).length, 0);
    f.store.observeNativeUsage(f.turn.id, 1, 100, breakdown(70, 60, 30));
    assert.equal(
      f.store.reminders.summary(f.root.id, "tree").metrics.totalTokens,
      100,
    );
    assert.equal(alerts(f.store, f.root.id).length, 1);
    f.store.observeNativeUsage(f.turn.id, 1, 200);
    assert.equal(
      f.store.reminders.summary(f.root.id, "tree").metrics.outputTokens,
      null,
    );
    assert.equal(alerts(f.store, f.root.id).length, 1);
  } finally {
    f.close();
  }
});
test("schema-11 migration reconstructs native breakdown and honors historical single warnings", () => {
  const f = fixture();
  try {
    f.store.observeNativeUsage(f.turn.id, 1, 100, breakdown(80, 50, 20));
    f.store.note(f.root.id, "usage.threshold_exceeded", {
      warningThresholdTokens: 100,
    });
    const binding = f.store.binding(f.root.id);
    f.store.db
      .prepare("UPDATE agents SET capacity=100 WHERE id=?")
      .run(f.root.id);
    f.store.db.exec(
      "DROP TABLE token_reminders; DROP TABLE token_usage_samples; DELETE FROM events WHERE kind='usage.reminder'; UPDATE schema_version SET version=11",
    );
    f.reopen();
    assert.deepEqual(f.store.binding(f.root.id), binding);
    assert.equal(f.store.agent(f.root.id).capacity, 0);
    assert.equal(
      f.store.reminders.summary(f.root.id, "tree").metrics.uncachedInputTokens,
      30,
    );
    f.store.observeNativeUsage(f.turn.id, 1, 100, breakdown(80, 50, 20));
    assert.equal(alerts(f.store, f.root.id).length, 0);
    assert.equal(f.store.agent(f.root.id).turns, 1);
  } finally {
    f.close();
  }
});
