import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Actor, type TreeLimits } from "../../src/storage/store.ts";
import { AgentTreeError } from "../../src/core/errors.ts";

const limits: TreeLimits = {
  tokenPolicy: "enforce" as const,
  tokens: 10000,
  maxDepth: 2,
  maxAgents: 3,
  maxConcurrentTurns: 3,
  maxTurnsPerAgent: 8,
  turnReservation: 100,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cat-store-test-"));
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  return {
    dir,
    path,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(path);
      return store;
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function running(
  store: Store,
  id: string,
  thread: string,
): { actor: Actor; attempt: string } {
  const b = store.binding(id) ?? store.bind(id, thread, "test");
  const a = store.prepare(id, "test input");
  store.markStarting(a.id);
  store.attachTurn(a.id, b.generation, `turn-${a.id}`);
  return {
    actor: store.authenticate(b.thread_id, `turn-${a.id}`, b.generation),
    attempt: a.id,
  };
}
const error = (code: string) => (e: unknown) =>
  e instanceof AgentTreeError && e.code === code;

test("processed receipt confirms consumption while the delegated child remains running, including after reopen", () => {
  const f = fixture();
  try {
    const root = f.store.createRoot("A", "delegate input", limits);
    const message = f.store.operatorSend(
      root.id,
      "input",
      "delegate this request",
    );
    const ar = running(f.store, root.id, "thread-a");
    const child = f.store.spawn(ar.actor, "delegate", {
      name: "B",
      role: "worker",
      task: "perform delegated work",
      tokens: 1000,
    });
    const br = running(f.store, child.id, "thread-b");
    f.store.acknowledge(ar.actor, [message]);
    assert.equal(f.store.messages(root.id)[0]?.status, "acknowledged");
    f.store.observeUsage(ar.attempt, 1, 10);
    f.store.finish(
      ar.attempt,
      1,
      "completed",
      "Delegated; waiting for child result",
    );
    f.reopen();
    assert.equal(f.store.messages(root.id)[0]?.status, "processed");
    assert.equal(f.store.attempt(ar.attempt).state, "completed");
    assert.equal(f.store.attempt(br.attempt).state, "running");
    assert.equal(f.store.messages(root.id).length, 1);
  } finally {
    f.close();
  }
});

test("tree budget exposes excess liability and persists one threshold alert without hiding actual overruns", () => {
  const f = fixture();
  try {
    const root = f.store.createRoot("A", "work", limits);
    const ar = running(f.store, root.id, "thread-a");
    assert.equal(f.store.budgetStatus(root.tree_id).availableTokens, 9900);
    f.store.observeNativeUsage(ar.attempt, 1, 10050);
    const pool = f.store.budgetStatus(root.tree_id);
    assert.equal(pool.availableTokens, 0);
    assert.equal(pool.excessLiabilityTokens, 50);
    f.store.observeNativeUsage(ar.attempt, 1, 10050);
    f.store.observeNativeUsage(ar.attempt, 1, 10060);
    f.store.finish(ar.attempt, 1, "completed", "done with excess usage");
    assert.equal(f.store.agent(root.id).spent, 10060);
    assert.equal(f.store.budgetStatus(root.tree_id).excessLiabilityTokens, 60);
    const events = f.store
      .events(root.id)
      .filter((e) => e.kind === "budget.tree_overcommitted");
    assert.equal(events.length, 1);
    f.reopen();
    assert.equal(f.store.budgetStatus(root.tree_id).excessLiabilityTokens, 60);
    assert.throws(
      () => f.store.prepare(root.id, "cannot spend more"),
      error("BUDGET_EXHAUSTED"),
    );
  } finally {
    f.close();
  }
});

test("persistent recursive tree, idempotent spawn, allocation conservation and provenance", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("same role", "delegate", limits);
    const ar = running(f.store, a.id, "thread-a");
    const input = {
      name: "same role",
      role: "worker",
      task: "delegate again",
      tokens: 4000,
    };
    const b = f.store.spawn(ar.actor, "spawn-b", input);
    assert.equal(f.store.spawn(ar.actor, "spawn-b", input).id, b.id);
    const br = running(f.store, b.id, "thread-b");
    const c = f.store.spawn(br.actor, "spawn-c", { ...input, tokens: 1000 });
    assert.equal(c.parent_id, b.id);
    assert.equal(b.parent_id, a.id);
    assert.notEqual(a.id, "thread-a");
    assert.equal(
      f.store.agents(a.tree_id).reduce((n, x) => n + x.capacity, 0),
      limits.tokens,
    );
    assert.throws(
      () => f.store.spawn(ar.actor, "spawn-b", { ...input, task: "different" }),
      error("CONFLICT"),
    );
    assert.throws(
      () => f.store.spawn({ ...ar.actor, agentId: b.id }, "spoof", input),
      error("FORBIDDEN"),
    );
    assert.throws(
      () =>
        f.store.authenticate(
          "thread-b",
          ar.actor.turnId,
          br.actor.bindingGeneration,
        ),
      error("FORBIDDEN"),
    );
    const reopened = f.reopen();
    assert.equal(reopened.agent(c.id).parent_id, b.id);
    assert.equal(reopened.binding(a.id)?.thread_id, "thread-a");
    assert.equal(reopened.attempt(ar.attempt).state, "running"); // Reopening never silently restarts native execution.
  } finally {
    f.close();
  }
});

test("one live owner per database; independent state directories remain usable", () => {
  const f = fixture();
  try {
    assert.throws(() => new Store(f.path), error("OWNER_ACTIVE"));
    const other = fixture();
    other.close();
    f.reopen();
    assert.ok(f.store.generation > 1);
  } finally {
    f.close();
  }
});

test("queued message survives restart; delivery acknowledgment alone does not finish processing", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "worker",
      task: "report",
      tokens: 1000,
    });
    const br = running(f.store, b.id, "thread-b");
    const id = f.store.send(br.actor, "result", a.id, "42");
    assert.equal(f.store.send(br.actor, "result", a.id, "42"), id);
    assert.throws(
      () => f.store.send(br.actor, "result", a.id, "43"),
      error("CONFLICT"),
    );
    f.store.observeUsage(ar.attempt, 1, 20);
    f.store.finish(ar.attempt, 1, "completed", "delegated");
    f.reopen();
    assert.equal(f.store.messages(a.id)[0]?.status, "queued");
    const resumed = running(f.store, a.id, "thread-a");
    f.store.acknowledge(resumed.actor, [id]);
    assert.equal(f.store.messages(a.id)[0]?.status, "acknowledged");
    f.store.observeUsage(resumed.attempt, 1, 15);
    f.store.finish(resumed.attempt, 1, "completed", "42");
    assert.equal(f.store.messages(a.id)[0]?.status, "processed");
    assert.equal(f.store.messages(a.id).length, 1);
  } finally {
    f.close();
  }
});

test("graph messages within tree; cross-tree spoof and delivery receipt theft rejected", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.createRoot("B", "unrelated tree", limits);
    assert.throws(
      () => f.store.send(ar.actor, "cross", b.id, "hello"),
      error("FORBIDDEN"),
    );
    const c = f.store.spawn(ar.actor, "child", {
      name: "C",
      role: "worker",
      task: "test",
      tokens: 1000,
    });
    const cr = running(f.store, c.id, "thread-c");
    const id = f.store.send(ar.actor, "child-message", c.id, "hello");
    assert.throws(
      () => f.store.acknowledge(ar.actor, [id]),
      error("FORBIDDEN"),
    );
    assert.throws(
      () => f.store.acknowledge(cr.actor, [id]),
      error("FORBIDDEN"),
    ); // Arrived after this delivery attempt was claimed.
  } finally {
    f.close();
  }
});

test("generation fencing and uncertain attempts prohibit unsafe rebind or replay", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const r = running(f.store, a.id, "old-thread");
    f.store.uncertain(r.attempt, "ACK lost");
    f.reopen();
    assert.equal(f.store.attempt(r.attempt).state, "unknown");
    assert.throws(
      () => f.store.bind(a.id, "new-thread", "test"),
      error("STATE_BLOCKED"),
    );
    f.store.attachTurn(r.attempt, 1, r.actor.turnId);
    f.store.observeUsage(r.attempt, 1, 12);
    f.store.finish(r.attempt, 1, "completed", "done");
    const b = f.store.bind(a.id, "new-thread", "test");
    assert.equal(b.generation, 2);
    assert.equal(b.agent_id, a.id);
    assert.throws(
      () => f.store.authenticate("old-thread", r.actor.turnId, 1),
      error("STALE_BINDING"),
    );
    assert.throws(
      () => f.store.observeUsage(r.attempt, 1, 999),
      error("STALE_BINDING"),
    );
    assert.equal(f.store.agent(a.id).spent, 12);
  } finally {
    f.close();
  }
});

test("budget unknown liability persists; duplicate usage is not charged twice; overspend is truthful", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", { ...limits, tokens: 200 });
    const first = running(f.store, a.id, "thread-a");
    f.store.finish(first.attempt, 1, "completed", "usage missing");
    assert.equal(f.store.agent(a.id).reserved, 100);
    f.reopen();
    assert.equal(f.store.agent(a.id).reserved, 100);
    assert.throws(
      () =>
        f.store.prepare(
          a.id,
          "unknown usage cannot be treated as a trustworthy bound",
        ),
      error("STATE_BLOCKED"),
    );
    f.store.settleFinalUsage(first.attempt, 1, 70, "operator final receipt");
    const second = running(f.store, a.id, "thread-a");
    f.store.observeUsage(second.attempt, 1, 150);
    f.store.observeUsage(second.attempt, 1, 150);
    f.store.observeUsage(second.attempt, 1, 140);
    f.store.finish(second.attempt, 1, "completed", "done");
    f.store.finish(second.attempt, 1, "completed", "duplicate notification");
    assert.equal(f.store.agent(a.id).spent, 220);
    assert.equal(f.store.agent(a.id).reserved, 0);
    assert.throws(
      () => f.store.prepare(a.id, "new work"),
      error("BUDGET_EXHAUSTED"),
    );
  } finally {
    f.close();
  }
});

test("constraints reject excess depth, lifetime agents and concurrent Turn admission", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", {
      ...limits,
      maxAgents: 2,
      maxConcurrentTurns: 1,
    });
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "worker",
      task: "work",
      tokens: 1000,
    });
    f.store.bind(b.id, "thread-b", "test");
    assert.throws(() => f.store.prepare(b.id, "work"), error("STATE_BLOCKED"));
    assert.throws(
      () =>
        f.store.spawn(ar.actor, "overflow", {
          name: "C",
          role: "worker",
          task: "work",
          tokens: 1000,
        }),
      error("STATE_BLOCKED"),
    );
    assert.equal(f.store.agents(a.tree_id).length, 2);
    const zero = f.store.createRoot("Z", "no children", {
      ...limits,
      maxDepth: 0,
    });
    const zr = running(f.store, zero.id, "thread-z");
    assert.throws(
      () =>
        f.store.spawn(zr.actor, "forbidden-child", {
          name: "C",
          role: "worker",
          task: "work",
          tokens: 1000,
        }),
      error("STATE_BLOCKED"),
    );
  } finally {
    f.close();
  }
});

test("unacknowledged completion records uncertainty rather than declaring message processed", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const ar = running(f.store, a.id, "thread-a");
    const id = f.store.send(ar.actor, "self", a.id, "followup");
    f.store.observeUsage(ar.attempt, 1, 1);
    f.store.finish(ar.attempt, 1, "completed", "initial");
    const wake = running(f.store, a.id, "thread-a");
    f.store.observeUsage(wake.attempt, 1, 1);
    f.store.finish(wake.attempt, 1, "completed", "forgot receipt");
    assert.equal(
      f.store.messages(a.id).find((m) => m.id === id)?.status,
      "unknown",
    );
  } finally {
    f.close();
  }
});

test("human subtree pause persists, blocks descendants and cannot be removed by model resume", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "worker",
      task: "work",
      tokens: 3000,
    });
    const br = running(f.store, b.id, "thread-b");
    f.store.control(null, b.id, "pause");
    assert.equal(f.store.agent(a.id).desired, "active");
    assert.equal(f.store.agent(b.id).desired, "paused");
    assert.deepEqual(f.store.control(br.actor, b.id, "resume"), []);
    assert.equal(f.store.agent(b.id).desired, "paused");
    assert.throws(
      () =>
        f.store.spawn(br.actor, "escape", {
          name: "C",
          role: "worker",
          task: "escape",
          tokens: 1000,
        }),
      error("STATE_BLOCKED"),
    );
    f.reopen();
    assert.equal(f.store.agent(b.id).desired, "paused");
    f.store.control(null, b.id, "resume");
    assert.equal(f.store.agent(b.id).desired, "active");
    assert.throws(
      () => f.store.control(br.actor, a.id, "terminate"),
      error("FORBIDDEN"),
    );
    assert.equal(f.store.attempt(br.attempt).state, "running"); // Pause drains; it never fabricates interruption.
  } finally {
    f.close();
  }
});

test("terminate defaults to subtree, preserves Threads, interrupts explicitly and refunds only unconsumed budget", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "worker",
      task: "work",
      tokens: 3000,
    });
    const br = running(f.store, b.id, "thread-b");
    const c = f.store.spawn(br.actor, "c", {
      name: "C",
      role: "worker",
      task: "work",
      tokens: 1000,
    });
    f.store.bind(c.id, "thread-c", "test");
    const pending = f.store.prepare(c.id, "not yet sent");
    const interrupted = f.store.control(null, b.id, "terminate");
    assert.deepEqual(
      interrupted.map((a) => a.id),
      [br.attempt],
    );
    assert.equal(f.store.agent(c.id).desired, "terminated");
    assert.equal(f.store.attempt(pending.id).state, "cancelled");
    assert.equal(f.store.binding(c.id)?.thread_id, "thread-c");
    assert.equal(f.store.agent(b.id).reserved, 100);
    assert.equal(f.store.attempt(br.attempt).state, "running");
    f.store.observeUsage(br.attempt, 1, 20);
    f.store.finish(br.attempt, 1, "interrupted", "confirmed interruption");
    assert.equal(f.store.agent(b.id).reserved, 100);
    f.store.settleFinalUsage(br.attempt, 1, 20, "confirmed final receipt");
    assert.equal(f.store.agent(b.id).capacity, 20);
    assert.equal(f.store.agent(b.id).spent, 20);
    assert.equal(f.store.agent(a.id).capacity, limits.tokens - 20);
    assert.throws(
      () => f.store.control(null, b.id, "resume"),
      error("STATE_BLOCKED"),
    );
  } finally {
    f.close();
  }
});

test("native cumulative usage counts all model requests once across Turns, including late terminal usage", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const first = running(f.store, a.id, "thread-a");
    f.store.observeNativeUsage(first.attempt, 1, 40);
    f.store.observeNativeUsage(first.attempt, 1, 90);
    f.store.observeNativeUsage(first.attempt, 1, 90);
    f.store.observeNativeUsage(first.attempt, 1, 40);
    assert.equal(f.store.attempt(first.attempt).observed, 90);
    f.store.finish(first.attempt, 1, "completed", "done");
    f.store.observeNativeUsage(first.attempt, 1, 95);
    assert.equal(f.store.agent(a.id).spent, 95);
    const second = running(f.store, a.id, "thread-a");
    f.store.observeNativeUsage(second.attempt, 1, 220);
    assert.equal(f.store.attempt(second.attempt).observed, 125);
    assert.equal(f.store.agent(a.id).reserved, 125);
    f.store.finish(second.attempt, 1, "completed", "done");
    assert.equal(f.store.agent(a.id).spent, 220);
    assert.equal(f.store.agent(a.id).reserved, 0);
    f.reopen();
    f.store.observeNativeUsage(second.attempt, 1, 220);
    assert.equal(f.store.agent(a.id).spent, 220);
  } finally {
    f.close();
  }
});

test("operator input has explicit human provenance and shares durable processing receipts without Agent impersonation", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const id = f.store.operatorSend(a.id, "input-one", "continue");
    assert.equal(f.store.operatorSend(a.id, "input-one", "continue"), id);
    assert.throws(
      () => f.store.operatorSend(a.id, "input-one", "different"),
      error("CONFLICT"),
    );
    f.reopen();
    const message = f.store.messages(a.id)[0];
    assert.equal(message?.origin, "human");
    assert.equal(message?.sender_id, null);
    const turn = running(f.store, a.id, "thread-a");
    f.store.acknowledge(turn.actor, [id]);
    f.store.observeUsage(turn.attempt, 1, 12);
    f.store.finish(turn.attempt, 1, "completed", "handled");
    assert.equal(f.store.messages(a.id)[0]?.status, "processed");
  } finally {
    f.close();
  }
});

test("single-Agent pause leaves existing children active, while subtree pause fences every descendant", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "worker",
      task: "work",
      tokens: 3000,
    });
    f.store.control(null, a.id, "pause", "agent");
    const br = running(f.store, b.id, "thread-b");
    const c = f.store.spawn(br.actor, "c", {
      name: "C",
      role: "worker",
      task: "work",
      tokens: 1000,
    });
    f.store.control(null, a.id, "pause", "subtree");
    assert.equal(f.store.agent(c.id).desired, "paused");
    assert.equal(f.store.agent(b.id).desired, "paused");
    f.store.bind(c.id, "thread-c", "test");
    assert.throws(
      () => f.store.prepare(c.id, "escape"),
      error("STATE_BLOCKED"),
    );
  } finally {
    f.close();
  }
});

test("operator root creation is idempotent across restart and rejects conflicting retries", () => {
  const f = fixture();
  try {
    const first = f.store.createRoot("A", "task", limits, "root-operation");
    f.reopen();
    assert.equal(
      f.store.createRoot("A", "task", limits, "root-operation").id,
      first.id,
    );
    assert.throws(
      () => f.store.createRoot("A", "other", limits, "root-operation"),
      error("CONFLICT"),
    );
    assert.equal(f.store.agents().length, 1);
  } finally {
    f.close();
  }
});

test("causal trace persists from parent Turn through spawn and message-triggered wake", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "task", limits);
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "child", {
      name: "B",
      role: "worker",
      task: "report",
      tokens: 1000,
    });
    const br = running(f.store, b.id, "thread-b");
    const rootAttempt = f.store.attempt(ar.attempt);
    assert.equal(f.store.attempt(br.attempt).trace_id, rootAttempt.trace_id);
    assert.equal(f.store.attempt(br.attempt).parent_turn_id, ar.actor.turnId);
    const message = f.store.send(br.actor, "report", a.id, "42");
    f.store.observeUsage(ar.attempt, 1, 10);
    f.store.finish(ar.attempt, 1, "completed", "delegated");
    const wake = f.store.prepare(a.id, "handle reply", null, message);
    assert.equal(wake.trace_id, rootAttempt.trace_id);
    assert.equal(wake.parent_turn_id, br.actor.turnId);
    f.reopen();
    assert.equal(f.store.attempt(wake.id).trace_id, rootAttempt.trace_id);
  } finally {
    f.close();
  }
});

test("empty binding replacement preserves unsent attempt, identity and reservation but never permits retiring dispatched work", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "task", limits);
    f.store.bind(a.id, "empty-old", "test");
    const prepared = f.store.prepare(a.id, "not sent");
    f.store.retireUnstartedBinding(a.id);
    assert.equal(f.store.binding(a.id), undefined);
    const binding = f.store.bind(a.id, "empty-replacement", "test");
    assert.equal(binding.generation, 2);
    assert.equal(f.store.attempt(prepared.id).thread_id, "empty-replacement");
    assert.equal(f.store.attempt(prepared.id).binding_generation, 2);
    assert.equal(f.store.agent(a.id).reserved, 100);
    f.store.markStarting(prepared.id);
    assert.throws(
      () => f.store.retireUnstartedBinding(a.id),
      error("STATE_BLOCKED"),
    );
  } finally {
    f.close();
  }
});

test("runtime epoch migration preserves prior generations and represents unavailable daemon PID as null", async () => {
  const f = fixture();
  try {
    f.store.registerRuntime("default", 123, "fixture");
    f.store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.path);
    db.exec(
      "ALTER TABLE runtime_connections RENAME TO runtime_connections_v2;CREATE TABLE runtime_connections(generation INTEGER PRIMARY KEY AUTOINCREMENT,domain TEXT NOT NULL,native_pid INTEGER NOT NULL,protocol_version TEXT NOT NULL,owner_generation INTEGER NOT NULL,created_at TEXT NOT NULL);INSERT INTO runtime_connections SELECT * FROM runtime_connections_v2;DROP TABLE runtime_connections_v2;UPDATE schema_version SET version=1;",
    );
    db.close();
    f.reopen();
    const next = f.store.registerRuntime("default", null, "fixture");
    assert.equal(next, 2);
    assert.equal(f.store.runtimeConnections()[0]?.native_pid, 123);
    assert.equal(f.store.runtimeConnections()[1]?.native_pid, null);
  } finally {
    f.close();
  }
});

test("explicit message batch claims only messages actually included in the Turn", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "task", limits);
    f.store.bind(a.id, "thread-a", "test");
    const ids = ["one", "two", "three"].map((k) =>
      f.store.operatorSend(a.id, k, k),
    );
    const delivery = f.store.prepare(
      a.id,
      "first two only",
      null,
      ids[0]!,
      ids.slice(0, 2),
    );
    f.store.markStarting(delivery.id);
    f.store.attachTurn(delivery.id, 1, "turn-one");
    const actor = f.store.authenticate("thread-a", "turn-one", 1);
    assert.equal(
      f.store.messages(a.id).find((m) => m.id === ids[0])?.status,
      "delivering",
    );
    assert.equal(
      f.store.messages(a.id).find((m) => m.id === ids[1])?.status,
      "delivering",
    );
    assert.equal(
      f.store.messages(a.id).find((m) => m.id === ids[2])?.status,
      "queued",
    );
    assert.throws(
      () => f.store.acknowledge(actor, [ids[2]!]),
      error("FORBIDDEN"),
    );
    f.store.acknowledge(actor, ids.slice(0, 2));
    f.store.observeUsage(delivery.id, 1, 10);
    f.store.finish(delivery.id, 1, "completed", "handled two");
    assert.equal(
      f.store.messages(a.id).find((m) => m.id === ids[2])?.status,
      "queued",
    );
  } finally {
    f.close();
  }
});
test("a child overspend blocks global admission even when the parent has unspent local allocation", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "task", {
      ...limits,
      turnReservation: 1000,
    });
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "worker",
      task: "work",
      tokens: 2000,
    });
    const br = running(f.store, b.id, "thread-b");
    f.store.observeUsage(br.attempt, 1, 9000);
    f.store.finish(
      br.attempt,
      1,
      "completed",
      "actual usage exceeded reservation",
    );
    f.store.observeUsage(ar.attempt, 1, 100);
    f.store.finish(ar.attempt, 1, "completed", "done");
    assert.ok(f.store.agent(a.id).capacity - f.store.agent(a.id).spent >= 1000);
    assert.throws(
      () => f.store.prepare(a.id, "new cost"),
      error("BUDGET_EXHAUSTED"),
    );
    assert.equal(f.store.budgetStatus(a.tree_id).spent, 9100);
  } finally {
    f.close();
  }
});

test("cancel differs from terminate: unsent deliveries cancel atomically, sessions remain and fresh work can resume", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "worker",
      task: "work",
      tokens: 3000,
    });
    const br = running(f.store, b.id, "thread-b");
    const c = f.store.spawn(br.actor, "c", {
      name: "C",
      role: "worker",
      task: "work",
      tokens: 1000,
    });
    f.store.bind(c.id, "thread-c", "test");
    const message = f.store.operatorSend(
      c.id,
      "first-input",
      "not dispatched yet",
    );
    const prepared = f.store.prepare(c.id, "not yet issued", null, message, [
      message,
    ]);
    const interrupts = f.store.control(null, b.id, "cancel");
    assert.deepEqual(
      interrupts.map((x) => x.id),
      [br.attempt],
    );
    assert.equal(f.store.agent(b.id).desired, "cancelled");
    assert.equal(f.store.agent(c.id).desired, "cancelled");
    assert.equal(f.store.agent(a.id).desired, "active");
    assert.equal(f.store.binding(c.id)?.thread_id, "thread-c");
    assert.equal(f.store.attempt(prepared.id).state, "cancelled");
    assert.equal(f.store.messages(c.id)[0]?.status, "cancelled");
    assert.equal(f.store.agent(c.id).reserved, 0);
    assert.equal(f.store.agent(c.id).capacity, 1000);
    assert.throws(
      () => f.store.operatorSend(c.id, "blocked", "new work"),
      error("STATE_BLOCKED"),
    );
    f.store.observeUsage(br.attempt, 1, 15);
    f.store.finish(
      br.attempt,
      1,
      "interrupted",
      "native interruption confirmed",
    );
    f.reopen();
    f.store.settleFinalUsage(br.attempt, 1, 15, "confirmed final receipt");
    f.store.control(null, b.id, "resume");
    const fresh = f.store.operatorSend(c.id, "fresh", "newly authorized work");
    f.store.prepare(c.id, "fresh input", null, fresh, [fresh]);
    assert.equal(
      f.store.messages(c.id).find((m) => m.id === message)?.status,
      "cancelled",
    );
    assert.equal(
      f.store.messages(c.id).find((m) => m.id === fresh)?.status,
      "delivering",
    );
  } finally {
    f.close();
  }
});

test("model resume respects management authority: a parent may clear descendant self-pause, never the reverse or a human pause", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "root", limits);
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "administrator label grants no authority",
      task: "work",
      tokens: 2000,
    });
    const br = running(f.store, b.id, "thread-b");
    f.store.control(br.actor, b.id, "pause", "agent");
    f.store.control(ar.actor, b.id, "resume", "agent");
    assert.equal(f.store.agent(b.id).desired, "active");
    f.store.control(ar.actor, b.id, "pause", "agent");
    f.store.control(br.actor, b.id, "resume", "agent");
    assert.equal(f.store.agent(b.id).desired, "paused");
    f.store.control(null, b.id, "pause");
    f.store.control(ar.actor, b.id, "resume");
    assert.equal(f.store.agent(b.id).desired, "paused");
    assert.throws(
      () => f.store.control(br.actor, a.id, "terminate"),
      error("FORBIDDEN"),
    );
  } finally {
    f.close();
  }
});

test("interrupted partial usage remains unsettled across restart; human final receipt and native replay never double charge", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "task", limits);
    const first = running(f.store, a.id, "thread-a");
    f.store.observeNativeUsage(first.attempt, 1, 20);
    f.store.finish(
      first.attempt,
      1,
      "interrupted",
      "cancelled during a model call",
    );
    assert.equal(f.store.agent(a.id).spent, 20);
    assert.equal(f.store.agent(a.id).reserved, 100);
    f.reopen();
    f.store.observeNativeUsage(first.attempt, 1, 30);
    assert.equal(f.store.agent(a.id).spent, 30);
    assert.equal(f.store.agent(a.id).reserved, 100);
    assert.deepEqual(f.store.budgetStatus(a.tree_id).unknownUsageAttempts, [
      first.attempt,
    ]);
    assert.throws(
      () => f.store.prepare(a.id, "more spending"),
      error("STATE_BLOCKED"),
    );
    assert.throws(
      () => f.store.settleFinalUsage(first.attempt, 1, 29, "too little"),
      error("CONFLICT"),
    );
    f.store.settleFinalUsage(
      first.attempt,
      1,
      50,
      "operator reconciled final receipt",
    );
    f.store.settleFinalUsage(first.attempt, 1, 50, "duplicate receipt");
    assert.equal(f.store.agent(a.id).spent, 50);
    assert.equal(f.store.agent(a.id).reserved, 0);
    assert.equal(f.store.attempt(first.attempt).observed, 30);
    f.store.observeNativeUsage(first.attempt, 1, 50);
    assert.equal(f.store.agent(a.id).spent, 50);
    // Manual attestation must not advance the native cumulative cursor.
    const next = running(f.store, a.id, "thread-a");
    f.store.observeNativeUsage(next.attempt, 1, 75);
    f.store.finish(next.attempt, 1, "completed", "done");
    assert.equal(f.store.agent(a.id).spent, 75);
    const receipt = f.store
      .events(a.id)
      .find((e) => e.kind === "budget.settled");
    assert.equal(JSON.parse(String(receipt?.body)).source, "human-attested");
  } finally {
    f.close();
  }
});

test("schema 2 partial interruption is conservatively migrated once, without replaying consumed charges", async () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "task", limits);
    const first = running(f.store, a.id, "thread-a");
    f.store.observeNativeUsage(first.attempt, 1, 20);
    f.store.finish(first.attempt, 1, "interrupted", "partial");
    f.store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(f.path);
    db.exec(
      "DROP TABLE attempt_accounting; UPDATE schema_version SET version=2; UPDATE turn_attempts SET reserved=0; UPDATE agents SET reserved=0;",
    );
    db.close();
    f.reopen();
    assert.equal(f.store.agent(a.id).spent, 20);
    assert.equal(f.store.agent(a.id).reserved, 100);
    f.reopen();
    assert.equal(f.store.agent(a.id).reserved, 100);
    f.store.settleFinalUsage(
      first.attempt,
      1,
      25,
      "reconciled migration receipt",
    );
    assert.equal(f.store.agent(a.id).spent, 25);
    f.reopen();
    assert.equal(f.store.agent(a.id).reserved, 0);
  } finally {
    f.close();
  }
});

test("communication is a same-tree graph while control remains a subtree permission", () => {
  const f = fixture();
  try {
    const a = f.store.createRoot("A", "coordinate", {
      ...limits,
      maxAgents: 4,
    });
    const ar = running(f.store, a.id, "thread-a");
    const b = f.store.spawn(ar.actor, "b", {
      name: "B",
      role: "lead",
      task: "delegate",
      tokens: 2000,
    });
    const sibling = f.store.spawn(ar.actor, "sibling", {
      name: "Sibling",
      role: "peer",
      task: "receive",
      tokens: 1000,
    });
    const br = running(f.store, b.id, "thread-b");
    const c = f.store.spawn(br.actor, "c", {
      name: "C",
      role: "worker",
      task: "work",
      tokens: 1000,
    });
    const cr = running(f.store, c.id, "thread-c");
    const crossBranch = f.store.send(
      cr.actor,
      "peer-message",
      sibling.id,
      "cross-branch result",
    );
    const crossLevel = f.store.send(
      cr.actor,
      "root-message",
      a.id,
      "direct root result",
    );
    assert.equal(f.store.messages(sibling.id)[0]?.id, crossBranch);
    assert.equal(f.store.messages(sibling.id)[0]?.sender_id, c.id);
    assert.equal(f.store.messages(a.id)[0]?.id, crossLevel);
    assert.throws(
      () => f.store.control(cr.actor, sibling.id, "terminate"),
      error("FORBIDDEN"),
    );
    assert.throws(
      () => f.store.control(cr.actor, a.id, "pause"),
      error("FORBIDDEN"),
    );
    f.store.control(ar.actor, b.id, "pause");
    assert.equal(f.store.agent(c.id).desired, "paused");
    assert.equal(f.store.agent(sibling.id).desired, "active");
    assert.equal(f.store.messages(sibling.id)[0]?.status, "queued");
    assert.equal(f.store.agent(c.id).parent_id, b.id);
    assert.equal(f.store.agent(sibling.id).parent_id, a.id);
  } finally {
    f.close();
  }
});
