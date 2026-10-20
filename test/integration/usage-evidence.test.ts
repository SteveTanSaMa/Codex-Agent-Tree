import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/storage/store.ts";
for (const policy of ["observe", "enforce"] as const) {
  for (const receiptFirst of policy === "enforce" ? [true] : [true, false]) {
    test(`${policy}: missing final sample, receipt ${receiptFirst ? "before" : "after"} next native total survives restart and replay`, () => {
      const dir = mkdtempSync("/tmp/cat-usage-evidence-");
      const path = join(dir, "s.sqlite");
      let s = new Store(path);
      try {
        const root = s.createRoot("A", "task", {
          tokenPolicy: policy,
          tokens: 10000,
          maxDepth: 0,
          maxAgents: 1,
          maxConcurrentTurns: 1,
          maxTurnsPerAgent: 8,
          turnReservation: 100,
        });
        s.bind(root.id, "thread", "test");
        const run = () => {
          const a = s.prepare(root.id, "work");
          s.markStarting(a.id);
          s.attachTurn(a.id, 1, "turn-" + a.id);
          return a.id;
        };
        const first = run();
        s.observeNativeUsage(first, 1, 30);
        s.finish(first, 1, "interrupted", "partial");
        // Enforce requires settlement before admission. Observe additionally tests late receipts.
        if (receiptFirst || policy === "enforce")
          s.settleFinalUsage(first, 1, 50, "verified receipt");
        const second = run();
        s.observeNativeUsage(second, 1, 75);
        s.finish(second, 1, "completed", "done");
        s.close();
        s = new Store(path);
        s.settleFinalUsage(first, 1, 50, "verified receipt replay");
        assert.equal(s.attempt(second).observed, 25);
        assert.equal(s.agent(root.id).spent, 75);
        assert.equal(
          s.db.prepare("SELECT total FROM usage_cursors").get()?.total,
          75,
        );
        const secondSample = s
          .events(root.id)
          .find((e) => e.kind === "usage.observed" && e.attempt_id === second)!;
        assert.equal(
          JSON.parse(String(secondSample.body)).delta,
          45,
          "Raw Thread delta remains independent of attributed cost",
        );
        s.observeNativeUsage(first, 1, 50); // older per-Turn sample, below the Thread cursor
        const lateSample = s
          .events(root.id)
          .filter((e) => e.kind === "usage.observed" && e.attempt_id === first)
          .at(-1)!;
        assert.equal(JSON.parse(String(lateSample.body)).delta, 0);
        s.observeNativeUsage(first, 1, 30);
        s.observeNativeUsage(second, 1, 75);
        assert.equal(s.agent(root.id).spent, 75);
        assert.equal(s.attempt(first).observed, 50);
        assert.equal(s.accounting(second).charged, 25);
        assert.equal(s.agent(root.id).reserved, 0);
        s.close();
        s = new Store(path);
        assert.equal(s.agent(root.id).spent, 75);
      } finally {
        s.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
test("multiple missing final samples reattribute late receipts; conflicting evidence rolls back atomically", () => {
  const dir = mkdtempSync("/tmp/cat-usage-multi-");
  const s = new Store(join(dir, "s.sqlite"));
  try {
    const a = s.createRoot("A", "task", {
      tokenPolicy: "observe",
      tokens: 10000,
      maxDepth: 0,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 8,
      turnReservation: 100,
    });
    s.bind(a.id, "thread", "test");
    const run = (total: number | null) => {
      const t = s.prepare(a.id, "work");
      s.markStarting(t.id);
      s.attachTurn(t.id, 1, t.id);
      if (total !== null) s.observeNativeUsage(t.id, 1, total);
      s.finish(t.id, 1, "completed", "done");
      return t.id;
    };
    const first = run(30),
      second = run(null),
      third = run(100);
    assert.deepEqual(s.budgetStatus(a.tree_id).unknownUsageAttempts, [second]);
    s.settleFinalUsage(second, 1, 20, "verified second");
    s.settleFinalUsage(first, 1, 50, "verified first");
    assert.equal(s.attempt(third).observed, 30);
    assert.equal(s.agent(a.id).spent, 100);
    s.observeNativeUsage(second, 1, 70);
    s.observeNativeUsage(first, 1, 50);
    assert.equal(s.agent(a.id).spent, 100);
    assert.equal(s.attempt(second).observed, 20);
    assert.throws(
      () => s.settleFinalUsage(first, 1, 90, "contradicts later sample"),
      /contradicts/,
    );
    assert.equal(s.agent(a.id).spent, 100);
    assert.equal(s.accounting(first).charged, 50);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("schema 6 migration reconstructs samples and receipts, corrects existing overcharge once", () => {
  const dir = mkdtempSync("/tmp/cat-usage-migrate-");
  const path = join(dir, "s.sqlite");
  let s = new Store(path);
  try {
    const a = s.createRoot("A", "task", {
      tokenPolicy: "observe",
      tokens: 10000,
      maxDepth: 0,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 8,
      turnReservation: 100,
    });
    s.bind(a.id, "thread", "test");
    const run = () => {
      const t = s.prepare(a.id, "work");
      s.markStarting(t.id);
      s.attachTurn(t.id, 1, t.id);
      return t.id;
    };
    const first = run();
    s.observeNativeUsage(first, 1, 30);
    s.finish(first, 1, "interrupted", "partial");
    s.settleFinalUsage(first, 1, 50, "verified");
    const second = run();
    s.observeNativeUsage(second, 1, 75);
    s.finish(second, 1, "completed", "done");
    s.db.exec(
      `UPDATE agents SET spent=95; UPDATE turn_attempts SET observed=45 WHERE id='${second}'; UPDATE attempt_accounting SET charged=45 WHERE attempt_id='${second}'; DROP TABLE usage_evidence; UPDATE schema_version SET version=6`,
    );
    s.close();
    s = new Store(path);
    assert.equal(s.agent(a.id).spent, 75);
    assert.equal(s.attempt(second).observed, 25);
    assert.equal(
      s.db.prepare("SELECT version FROM schema_version").get()?.version,
      15,
    );
    assert.equal(
      s.events(a.id).filter((e) => e.kind === "budget.settled").length,
      1,
    );
    s.close();
    s = new Store(path);
    assert.equal(s.agent(a.id).spent, 75);
    assert.equal(s.agent(a.id).reserved, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("late native evidence can exceed an attestation without charging the same prefix twice", () => {
  const dir = mkdtempSync("/tmp/cat-usage-late-");
  const s = new Store(join(dir, "s.sqlite"));
  try {
    const a = s.createRoot("A", "task", {
      tokenPolicy: "observe",
      tokens: 10000,
      maxDepth: 0,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 8,
      turnReservation: 100,
    });
    s.bind(a.id, "thread", "test");
    const run = () => {
      const t = s.prepare(a.id, "work");
      s.markStarting(t.id);
      s.attachTurn(t.id, 1, t.id);
      return t.id;
    };
    const first = run();
    s.observeNativeUsage(first, 1, 30);
    s.finish(first, 1, "interrupted", "stopped");
    s.settleFinalUsage(first, 1, 50, "receipt");
    const second = run();
    s.observeNativeUsage(second, 1, 75);
    s.finish(second, 1, "completed", "done");
    s.observeNativeUsage(first, 1, 60);
    assert.equal(s.accounting(first).charged, 60);
    assert.equal(s.accounting(second).charged, 15);
    assert.equal(s.agent(a.id).spent, 75);
    assert.throws(() => s.observeNativeUsage(first, 2, 90), /binding/i);
    assert.equal(s.agent(a.id).spent, 75);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy evidence gaps retain existing lower bounds and unknown liability during migration", () => {
  const dir = mkdtempSync("/tmp/cat-usage-legacy-");
  const path = join(dir, "s.sqlite");
  let s = new Store(path);
  try {
    const a = s.createRoot("A", "task", {
      tokenPolicy: "observe",
      tokens: 10000,
      maxDepth: 0,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 8,
      turnReservation: 100,
    });
    s.bind(a.id, "thread", "test");
    const t = s.prepare(a.id, "work");
    s.markStarting(t.id);
    s.attachTurn(t.id, 1, t.id);
    s.observeUsage(t.id, 1, 30);
    s.finish(t.id, 1, "interrupted", "partial");
    s.db.exec("DROP TABLE usage_evidence; UPDATE schema_version SET version=6");
    s.close();
    s = new Store(path);
    assert.equal(s.agent(a.id).spent, 30);
    assert.equal(s.agent(a.id).reserved, 100);
    assert.deepEqual(s.budgetStatus(a.tree_id).unknownUsageAttempts, [t.id]);
    s.settleFinalUsage(t.id, 1, 50, "verified receipt");
    assert.equal(s.agent(a.id).spent, 50);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration never converts a human-only receipt into a native observation floor", () => {
  const dir = mkdtempSync("/tmp/cat-usage-human-only-");
  const path = join(dir, "s.sqlite");
  let s = new Store(path);
  try {
    const a = s.createRoot("A", "task", {
      tokenPolicy: "observe",
      tokens: 10000,
      maxDepth: 0,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 8,
      turnReservation: 100,
    });
    s.bind(a.id, "thread", "test");
    const t = s.prepare(a.id, "work");
    s.markStarting(t.id);
    s.attachTurn(t.id, 1, t.id);
    s.finish(t.id, 1, "completed", "no sample");
    s.settleFinalUsage(t.id, 1, 50, "verified human only");
    s.db.exec(
      "DELETE FROM events WHERE kind='budget.settled'; DROP TABLE usage_evidence; UPDATE schema_version SET version=6",
    );
    s.close();
    s = new Store(path);
    assert.equal(s.attempt(t.id).observed, null);
    s.observeNativeUsage(t.id, 1, 30);
    assert.equal(s.attempt(t.id).observed, 30);
    assert.equal(s.accounting(t.id).charged, 50);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contradictory legacy receipts roll back the entire schema and ownership migration", async () => {
  const dir = mkdtempSync("/tmp/cat-usage-rollback-");
  const path = join(dir, "s.sqlite");
  const s = new Store(path);
  try {
    const a = s.createRoot("A", "task", {
      tokenPolicy: "observe",
      tokens: 10000,
      maxDepth: 0,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 8,
      turnReservation: 100,
    });
    s.bind(a.id, "thread", "test");
    const run = (total: number) => {
      const t = s.prepare(a.id, "work");
      s.markStarting(t.id);
      s.attachTurn(t.id, 1, t.id);
      s.observeNativeUsage(t.id, 1, total);
      s.finish(t.id, 1, "completed", "done");
      return t.id;
    };
    const first = run(30);
    s.settleFinalUsage(first, 1, 50, "verified");
    run(75);
    const receipt = s.events(a.id).find((e) => e.kind === "budget.settled")!;
    const body = JSON.parse(String(receipt.body));
    body.tokens = 100;
    s.db
      .prepare("UPDATE events SET body=? WHERE id=?")
      .run(JSON.stringify(body), String(receipt.id));
    s.db.exec("DROP TABLE usage_evidence; UPDATE schema_version SET version=6");
    s.close();
    assert.throws(() => new Store(path), /contradicts/);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    try {
      assert.equal(
        db.prepare("SELECT version FROM schema_version").get()?.version,
        6,
      );
      assert.equal(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='usage_evidence'")
          .get(),
        undefined,
      );
      assert.equal(db.prepare("SELECT spent FROM agents").get()?.spent, 75);
      assert.equal(db.prepare("SELECT id FROM owner").get()?.id, null);
    } finally {
      db.close();
    }
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
