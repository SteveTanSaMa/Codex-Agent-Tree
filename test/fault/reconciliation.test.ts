import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Coordinator,
  type RuntimePort,
} from "../../src/coordinator/coordinator.ts";
import { Store } from "../../src/storage/store.ts";
import type {
  RuntimeEvent,
  RuntimeRequest,
} from "../../src/runtime/codex/adapter.ts";

class FakeRuntime implements RuntimePort {
  onEvent: (e: RuntimeEvent) => void = () => {};
  onRequest: (r: RuntimeRequest) => void = () => {};
  onDisconnect: (e: Error) => void = () => {};
  turns: Record<string, unknown>[] = [];
  starts = 0;
  failHistory = false;
  failResume = false;
  connected = false;
  async connect() {
    this.connected = true;
  }
  connectionInfo() {
    return { nativePid: null, protocolVersion: "mock-fixture" };
  }
  disconnect() {
    this.connected = false;
  }
  isCurrent(g: number) {
    return this.connected && g === 2;
  }
  responses: unknown[] = [];
  respond(_request: RuntimeRequest, result: unknown) {
    this.responses.push(result);
  }
  respondError(_request: RuntimeRequest, code: number, message: string) {
    this.responses.push({ error: { code, message } });
  }
  async createThread() {
    return "unexpected-thread";
  }
  async resumeThread() {
    if (this.failResume) throw new Error("Empty native history cannot resume");
    return {};
  }
  async readThread() {
    if (this.failHistory) throw new Error("History unavailable");
    return {
      thread: { id: "thread-a", status: { type: "idle" }, turns: this.turns },
    };
  }
  async startTurn(_threadId: string, _input: string, _attemptId: string) {
    this.starts++;
    return `fake-turn-${this.starts}`;
  }
  async interrupt() {}
  emit(method: string, params: unknown, generation = 2) {
    this.onEvent({ method, params, connectionGeneration: generation });
  }
}
function fixture(state: "starting" | "running" = "starting") {
  const dir = mkdtempSync(join(tmpdir(), "cat-reconcile-"));
  const path = join(dir, "business.sqlite");
  const store = new Store(path);
  const root = store.createRoot("A", "original task", {
    tokens: 1000,
    maxDepth: 2,
    maxAgents: 3,
    maxConcurrentTurns: 2,
    maxTurnsPerAgent: 4,
    turnReservation: 100,
  });
  store.bind(root.id, "thread-a", "default");
  const a = store.prepare(root.id, "original input");
  store.markStarting(a.id);
  if (state === "running") store.attachTurn(a.id, 1, "native-turn");
  store.close();
  const runtime = new FakeRuntime();
  const coordinator = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "native"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  return {
    root,
    a,
    runtime,
    coordinator,
    async close() {
      await coordinator.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function turn(id: string, attempt: string, status: string) {
  return {
    id,
    status,
    items: [
      {
        type: "userMessage",
        content: [
          {
            type: "text",
            text: `[AgentTree attempt ${attempt}]\noriginal input`,
          },
        ],
      },
      { type: "agentMessage", text: "completed native work" },
    ],
  };
}

test("mock fault: lost start ACK is reconciled by unique persisted attempt marker, without turn/start replay", async () => {
  const f = fixture();
  try {
    f.runtime.turns = [turn("native-turn", f.a.id, "completed")];
    await f.coordinator.start();
    assert.equal(f.coordinator.store.attempt(f.a.id).turn_id, "native-turn");
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "completed");
    assert.equal(f.runtime.starts, 0);
    assert.equal(f.coordinator.store.agent(f.root.id).reserved, 100);
  } finally {
    await f.close();
  }
});
test("mock fault: live old native execution is adopted; stale connection callback cannot complete it", async () => {
  const f = fixture("running");
  try {
    f.runtime.turns = [turn("native-turn", f.a.id, "inProgress")];
    await f.coordinator.start();
    assert.equal(f.runtime.starts, 0);
    f.runtime.emit(
      "turn/completed",
      { threadId: "thread-a", turn: turn("native-turn", f.a.id, "completed") },
      1,
    );
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "running");
    f.runtime.emit("thread/tokenUsage/updated", {
      threadId: "thread-a",
      turnId: "native-turn",
      tokenUsage: { total: { totalTokens: 55 } },
    });
    f.runtime.emit("turn/completed", {
      threadId: "thread-a",
      turn: turn("native-turn", f.a.id, "completed"),
    });
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "completed");
    assert.equal(f.coordinator.store.agent(f.root.id).spent, 55);
    assert.equal(f.runtime.starts, 0);
  } finally {
    await f.close();
  }
});
test("mock fault: unavailable or ambiguous history leaves unknown work and retained liability, with no automatic retry", async () => {
  for (const missing of [true, false]) {
    const f = fixture();
    try {
      f.runtime.failHistory = missing;
      f.runtime.turns = missing
        ? []
        : [turn("one", f.a.id, "completed"), turn("two", f.a.id, "completed")];
      await f.coordinator.start();
      assert.equal(f.coordinator.store.attempt(f.a.id).state, "unknown");
      assert.equal(f.coordinator.store.agent(f.root.id).reserved, 100);
      assert.equal(f.runtime.starts, 0);
    } finally {
      await f.close();
    }
  }
});
test("mock fault: completed native Turn settles persisted processed receipt without a new turn/start", async () => {
  const f = fixture("running");
  try {
    const actor = f.coordinator.store.authenticate(
      "thread-a",
      "native-turn",
      1,
    );
    const id = f.coordinator.store.send(
      actor,
      "self-input",
      f.root.id,
      "handle once",
    );
    f.coordinator.store.observeUsage(f.a.id, 1, 10);
    f.coordinator.store.finish(f.a.id, 1, "completed", "initial");
    const delivery = f.coordinator.store.prepare(f.root.id, "handle once");
    f.coordinator.store.markStarting(delivery.id);
    f.coordinator.store.attachTurn(delivery.id, 1, "delivery-turn");
    f.coordinator.store.acknowledge(
      f.coordinator.store.authenticate("thread-a", "delivery-turn", 1),
      [id],
    );
    f.runtime.turns = [
      turn("native-turn", f.a.id, "completed"),
      turn("delivery-turn", delivery.id, "completed"),
    ];
    await f.coordinator.start();
    assert.equal(
      f.coordinator.store.messages(f.root.id)[0]?.status,
      "processed",
    );
    assert.equal(f.runtime.starts, 0);
  } finally {
    await f.close();
  }
});

test("event-driven scheduler wakes queued input after completion without a periodic polling loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-event-wake-"));
  const runtime = new FakeRuntime();
  const coordinator = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "native"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await coordinator.start();
    const root = coordinator.createRoot("A", "initial task", {
      tokens: 1000,
      maxDepth: 1,
      maxAgents: 2,
      maxConcurrentTurns: 2,
      maxTurnsPerAgent: 4,
      turnReservation: 100,
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(runtime.starts, 1);
    coordinator.submitInput(root.id, "input", "continue later");
    assert.equal(runtime.starts, 1);
    runtime.emit("thread/tokenUsage/updated", {
      threadId: "unexpected-thread",
      turnId: "fake-turn-1",
      tokenUsage: { total: { totalTokens: 10 } },
    });
    runtime.emit("turn/completed", {
      threadId: "unexpected-thread",
      turn: { id: "fake-turn-1", status: "completed", items: [] },
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(runtime.starts, 2);
    assert.equal(coordinator.store.messages(root.id)[0]?.status, "delivering");
    assert.equal(coordinator.store.attempts(root.id)[1]?.state, "running");
    assert.deepEqual(coordinator.diagnostics().errors, []);
  } finally {
    await coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("approval policy safely rejects current requests, persists the decision and ignores stale connection requests", async () => {
  const f = fixture("running");
  try {
    f.runtime.turns = [turn("native-turn", f.a.id, "inProgress")];
    await f.coordinator.start();
    f.runtime.onRequest({
      id: "approval-old",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-a", turnId: "native-turn" },
      connectionGeneration: 1,
    });
    assert.equal(f.runtime.responses.length, 0);
    f.runtime.onRequest({
      id: "approval-current",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-a", turnId: "native-turn" },
      connectionGeneration: 2,
    });
    assert.deepEqual(f.runtime.responses, [{ decision: "decline" }]);
    assert.equal(
      f.coordinator.store
        .events(f.root.id)
        .filter((e) => e.kind === "approval.declined").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("mock initialization crash: unsent prepared work rebinds an empty context without a second reservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-empty-recovery-"));
  const store = new Store(join(dir, "business.sqlite"));
  const root = store.createRoot("A", "initial work", {
    tokens: 1000,
    maxDepth: 1,
    maxAgents: 2,
    maxConcurrentTurns: 2,
    maxTurnsPerAgent: 4,
    turnReservation: 100,
  });
  store.bind(root.id, "thread-a", "default");
  const prepared = store.prepare(root.id, "not issued");
  store.close();
  const runtime = new FakeRuntime();
  runtime.failResume = true;
  const coordinator = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "native"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await coordinator.start();
    assert.equal(coordinator.store.binding(root.id)?.generation, 2);
    assert.equal(coordinator.store.attempt(prepared.id).state, "running");
    assert.equal(coordinator.store.agent(root.id).reserved, 100);
    assert.equal(coordinator.store.agent(root.id).turns, 1);
    assert.equal(runtime.starts, 1);
  } finally {
    await coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a late usage event unblocks queued work after an unknown-cost completion without a polling retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-late-usage-"));
  const runtime = new FakeRuntime();
  const coordinator = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "native"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await coordinator.start();
    const root = coordinator.createRoot("A", "initial task", {
      tokens: 1000,
      maxDepth: 1,
      maxAgents: 2,
      maxConcurrentTurns: 2,
      maxTurnsPerAgent: 4,
      turnReservation: 100,
    });
    await new Promise<void>((r) => setImmediate(r));
    coordinator.submitInput(root.id, "input", "continue");
    runtime.emit("turn/completed", {
      threadId: "unexpected-thread",
      turn: { id: "fake-turn-1", status: "completed", items: [] },
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(runtime.starts, 1);
    assert.equal(
      coordinator.store.budgetStatus(root.tree_id).unknownUsageAttempts.length,
      1,
    );
    runtime.emit("thread/tokenUsage/updated", {
      threadId: "unexpected-thread",
      turnId: "fake-turn-1",
      tokenUsage: { total: { totalTokens: 15 } },
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(runtime.starts, 2);
    assert.equal(coordinator.store.agent(root.id).spent, 15);
  } finally {
    await coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown retains exclusive ownership until the old control-channel cleanup barrier resolves", async () => {
  const f = fixture("running");
  let release: () => void = () => {};
  const barrier = new Promise<void>((yes) => {
    release = yes;
  });
  try {
    const stopping = f.coordinator.stop(barrier);
    await new Promise<void>((r) => setImmediate(r));
    assert.throws(
      () =>
        new Store(
          join(f.coordinator.options.stateDirectory, "business.sqlite"),
        ),
      /owns this database/,
    );
    release();
    await stopping;
    const next = new Store(
      join(f.coordinator.options.stateDirectory, "business.sqlite"),
    );
    next.close();
  } finally {
    release();
    await f.close();
  }
});

test("a failed channel cleanup is observed immediately, surfaced and still releases the old DB owner", async () => {
  const f = fixture("running");
  try {
    f.coordinator.submitInput(f.root.id, "queued-stop", "work");
    await assert.rejects(
      f.coordinator.stop(
        Promise.reject(new Error("controlled channel cleanup failure")),
      ),
      /controlled channel cleanup failure/,
    );
    const next = new Store(
      join(f.coordinator.options.stateDirectory, "business.sqlite"),
    );
    next.close();
  } finally {
    await f.close();
  }
});

test("recovery interrupts an adopted live Turn when cancel or terminate was already persisted", async () => {
  for (const action of ["cancel", "terminate"] as const) {
    const f = fixture("running");
    let requests = 0;
    try {
      f.coordinator.store.control(null, f.root.id, action);
      f.runtime.turns = [turn("native-turn", f.a.id, "inProgress")];
      f.runtime.interrupt = async () => {
        requests++;
      };
      await f.coordinator.start();
      assert.equal(requests, 1);
      assert.equal(
        f.coordinator.store.agent(f.root.id).desired,
        action === "cancel" ? "cancelled" : "terminated",
      );
      assert.equal(f.coordinator.store.attempt(f.a.id).state, "running");
      assert.equal(f.runtime.starts, 0);
    } finally {
      await f.close();
    }
  }
});
test("a completion racing an interrupt failure stays completed instead of being overwritten as unknown", async () => {
  const f = fixture("running");
  try {
    f.runtime.turns = [turn("native-turn", f.a.id, "inProgress")];
    await f.coordinator.start();
    f.runtime.interrupt = async () => {
      f.runtime.emit("turn/completed", {
        threadId: "thread-a",
        turn: turn("native-turn", f.a.id, "completed"),
      });
      throw new Error("native Turn ended before interrupt arrived");
    };
    await f.coordinator.control(f.root.id, "cancel");
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "completed");
    assert.equal(f.coordinator.store.agent(f.root.id).desired, "cancelled");
    assert.deepEqual(f.coordinator.diagnostics().errors, []);
  } finally {
    await f.close();
  }
});

test("cancel between turn/start dispatch and ACK interrupts as soon as the native Turn ID is learned, once", async () => {
  for (const startedEventFirst of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "cat-start-cancel-"));
    const runtime = new FakeRuntime();
    const coordinator = new Coordinator(
      {
        stateDirectory: dir,
        runtimeHome: join(dir, "native"),
        expectedVersion: "fixture",
      },
      runtime,
    );
    let rootId = "";
    let acknowledge: (value: string) => void = () => {};
    let interrupts = 0;
    runtime.interrupt = async () => {
      interrupts++;
    };
    runtime.startTurn = async (thread) => {
      runtime.starts++;
      coordinator.store.control(null, rootId, "cancel");
      if (startedEventFirst)
        runtime.emit("turn/started", {
          threadId: thread,
          turn: { id: "started-while-cancelled" },
        });
      return new Promise<string>((yes) => {
        acknowledge = yes;
      });
    };
    try {
      await coordinator.start();
      rootId = coordinator.createRoot("A", "work", {
        tokens: 1000,
        maxDepth: 1,
        maxAgents: 2,
        maxConcurrentTurns: 2,
        maxTurnsPerAgent: 4,
        turnReservation: 100,
      }).id;
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(coordinator.store.agent(rootId).desired, "cancelled");
      acknowledge("started-while-cancelled");
      await new Promise<void>((r) => setImmediate(r));
      runtime.emit("turn/started", {
        threadId: "unexpected-thread",
        turn: { id: "started-while-cancelled" },
      });
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(interrupts, 1);
      assert.equal(runtime.starts, 1);
      assert.equal(
        coordinator.store.attempts(rootId)[0]?.turn_id,
        "started-while-cancelled",
      );
    } finally {
      acknowledge("started-while-cancelled");
      await coordinator.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("operator usage settlement requires matching terminal native history and never trusts a live or missing Turn", async () => {
  const f = fixture("running");
  try {
    f.runtime.turns = [turn("native-turn", f.a.id, "interrupted")];
    await f.coordinator.start();
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "interrupted");
    f.runtime.turns = [turn("native-turn", f.a.id, "inProgress")];
    await assert.rejects(
      f.coordinator.settleUsage(f.a.id, 30, "review"),
      /still live/,
    );
    f.runtime.turns = [];
    await assert.rejects(
      f.coordinator.settleUsage(f.a.id, 30, "review"),
      /Matching terminal/,
    );
    f.runtime.turns = [turn("native-turn", f.a.id, "interrupted")];
    await f.coordinator.settleUsage(f.a.id, 30, "operator final receipt");
    assert.equal(f.coordinator.store.agent(f.root.id).spent, 30);
    assert.equal(f.coordinator.store.agent(f.root.id).reserved, 0);
    assert.equal(f.runtime.starts, 0);
  } finally {
    await f.close();
  }
});

test("completion event rechecks initially unhydrated native history, adopts one owned Turn and clears only its proven quarantine", async () => {
  const f = fixture();
  try {
    f.runtime.turns = [{ id: "native-turn", status: "inProgress", items: [] }];
    await f.coordinator.start();
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "unknown");
    assert.ok(f.coordinator.store.runtimeBlock(f.root.id));
    f.runtime.turns = [turn("native-turn", f.a.id, "completed")];
    f.runtime.emit(
      "turn/completed",
      {
        threadId: "thread-a",
        turn: { id: "native-turn", status: "completed", items: [] },
      },
      1,
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(
      f.coordinator.store.attempt(f.a.id).state,
      "unknown",
      "old connection cannot trigger recovery",
    );
    f.runtime.emit("turn/completed", {
      threadId: "thread-a",
      turn: { id: "native-turn", status: "completed", items: [] },
    });
    for (
      let i = 0;
      i < 30 && f.coordinator.store.attempt(f.a.id).state !== "completed";
      i++
    )
      await new Promise((r) => setImmediate(r));
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "completed");
    assert.equal(f.coordinator.store.attempt(f.a.id).turn_id, "native-turn");
    assert.equal(f.coordinator.store.runtimeBlock(f.root.id), undefined);
    assert.equal(f.runtime.starts, 0);
    assert.ok(
      f.coordinator.store
        .events(f.root.id)
        .some((e) => e.kind === "runtime.quarantine_reconciled"),
    );
  } finally {
    await f.close();
  }
});

test("a still-unowned foreign Turn prevents automatic quarantine release even after an owned completion is recovered", async () => {
  const f = fixture();
  try {
    f.runtime.turns = [
      { id: "native-turn", status: "inProgress", items: [] },
      { id: "foreign-turn", status: "inProgress", items: [] },
    ];
    await f.coordinator.start();
    f.runtime.turns = [
      turn("native-turn", f.a.id, "completed"),
      { id: "foreign-turn", status: "completed", items: [] },
    ];
    f.runtime.emit("turn/completed", {
      threadId: "thread-a",
      turn: { id: "native-turn", status: "completed", items: [] },
    });
    for (
      let i = 0;
      i < 30 && f.coordinator.store.attempt(f.a.id).state !== "completed";
      i++
    )
      await new Promise((r) => setImmediate(r));
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "completed");
    assert.ok(
      f.coordinator.store.runtimeBlock(f.root.id),
      "foreign completed effects are still unowned",
    );
    assert.equal(f.runtime.starts, 0);
  } finally {
    await f.close();
  }
});
