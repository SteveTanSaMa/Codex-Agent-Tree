import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/storage/store.ts";
function fixture(policy: "observe" | "enforce" = "observe") {
  const dir = mkdtempSync("/tmp/cat-fifo-");
  const path = join(dir, "s.sqlite");
  let s = new Store(path);
  const a = s.createRoot("A", "task", {
    tokenPolicy: policy,
    tokens: 10000,
    maxDepth: 0,
    maxAgents: 1,
    maxConcurrentTurns: 1,
    maxTurnsPerAgent: 8,
    turnReservation: 100,
  });
  s.bind(a.id, "thread", "test");
  const run = (i: number) => {
    const t = s.prepare(a.id, "work");
    s.markStarting(t.id);
    s.attachTurn(t.id, 1, "t" + i);
    return t;
  };
  return {
    a,
    run,
    get s() {
      return s;
    },
    reopen() {
      s.close();
      s = new Store(path);
    },
    close() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("FIFO is durable across human/agent sources, equal or reversed wall clock, dedupe and migration", () => {
  const f = fixture();
  try {
    const t = f.run(0),
      actor = f.s.authenticate("thread", "t0", 1),
      ids = [];
    for (let i = 0; i < 50; i++) {
      ids.push(
        i % 2
          ? f.s.send(actor, "s" + i, f.a.id, "a" + i)
          : f.s.operatorSend(f.a.id, "o" + i, "h" + i),
      );
    }
    f.s.db.exec(
      "UPDATE messages SET created_at='2099'; UPDATE operator_messages SET created_at='1900'",
    );
    assert.deepEqual(
      f.s.messages(f.a.id).map((m) => m.id),
      ids,
    );
    assert.equal(f.s.operatorSend(f.a.id, "o0", "h0"), ids[0]);
    assert.equal(f.s.messages(f.a.id).length, 50);
    f.s.finish(t.id, 1, "completed", "done");
    f.reopen();
    assert.deepEqual(
      f.s.messages(f.a.id).map((m) => m.id),
      ids,
    );
  } finally {
    f.close();
  }
});
for (const policy of ["observe", "enforce"] as const)
  for (const order of [
    [0, 1, 2],
    [2, 0, 1],
    [2, 1, 0],
    [1, 2, 0],
  ])
    test(
      policy +
        ": late usage receipts persist and converge without resubmission: " +
        order,
      () => {
        const f = fixture(policy);
        try {
          const ids = [];
          for (const [i, total] of [10, 50, 85].entries()) {
            const t = f.run(i);
            f.s.observeNativeUsage(t.id, 1, total);
            f.s.finish(t.id, 1, i === 2 ? "interrupted" : "completed", "done");
            ids.push(t.id);
          }
          for (const i of order) {
            f.s.submitUsageReceipt(
              ids[i]!,
              1,
              [30, 45, 10][i]!,
              "verified fixture",
            );
            f.reopen();
          }
          assert.equal(f.s.agent(f.a.id).spent, 85);
          assert.equal(f.s.agent(f.a.id).reserved, 0);
          assert.deepEqual(
            f.s.budgetStatus(f.a.tree_id).unknownUsageAttempts,
            [],
          );
          for (const id of ids)
            assert.equal(f.s.usageReceipts(id)[0]?.state, "applied");
          assert.equal(
            f.s.db.prepare("SELECT total FROM usage_cursors").get()?.total,
            85,
          );
        } finally {
          f.close();
        }
      },
    );

test("schema 7 messages backfill historical order once and new messages append durably", () => {
  const f = fixture();
  try {
    f.s.operatorSend(f.a.id, "old-b", "b");
    f.s.operatorSend(f.a.id, "old-a", "a");
    f.s.db.exec(
      "DROP TRIGGER message_enqueue_order; DROP TRIGGER operator_enqueue_order; DROP TABLE message_order; UPDATE schema_version SET version=7; UPDATE operator_messages SET created_at='2000'",
    );
    const historical = f.s.db
      .prepare("SELECT id FROM operator_messages ORDER BY created_at,id")
      .all()
      .map((r) => r.id);
    f.reopen();
    assert.deepEqual(
      f.s.messages(f.a.id).map((m) => m.id),
      historical,
    );
    const newest = f.s.operatorSend(f.a.id, "new", "new");
    f.s.db
      .prepare("UPDATE operator_messages SET created_at='1900' WHERE id=?")
      .run(newest);
    f.reopen();
    assert.deepEqual(
      f.s.messages(f.a.id).map((m) => m.id),
      [...historical, newest],
    );
    assert.equal(
      f.s.db.prepare("SELECT version FROM schema_version").get()?.version,
      9,
    );
  } finally {
    f.close();
  }
});
