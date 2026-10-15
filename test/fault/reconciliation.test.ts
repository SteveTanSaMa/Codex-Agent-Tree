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
  inputs: string[] = [];
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
    this.inputs.push(_input);
    return `fake-turn-${this.starts}`;
  }
  async interrupt() {}
  emit(method: string, params: unknown, generation = 2) {
    this.onEvent({ method, params, connectionGeneration: generation });
  }
}

test("message batching drains valid escaped inputs and visibly rejects an oversized legacy head without blocking later messages", async () => {
  for (const mode of ["valid", "legacy-human", "legacy-agent"]) {
    const legacy = mode !== "valid";
    const f = fixture("running");
    try {
      const body = legacy ? "\u0001".repeat(12000) : '"'.repeat(12000);
      const first =
        mode === "legacy-agent"
          ? f.coordinator.store.send(
              f.coordinator.store.authenticate("thread-a", "native-turn", 1),
              "first",
              f.root.id,
              "legacy placeholder",
            )
          : f.coordinator.store.operatorSend(
              f.root.id,
              "first",
              legacy ? "legacy placeholder" : body,
            );
      const second = f.coordinator.store.operatorSend(
        f.root.id,
        "second",
        "\\".repeat(12000),
      );
      const third = f.coordinator.store.operatorSend(
        f.root.id,
        "third",
        "small report",
      );
      f.coordinator.store.observeUsage(f.a.id, 1, 10);
      f.coordinator.store.finish(f.a.id, 1, "completed", "initial");
      // Inject an out-of-contract historical row only in this isolated business DB.
      // Public text validation rejects its controls, unlike ordinary accepted input.
      if (legacy)
        f.coordinator.store.db
          .prepare(
            `UPDATE ${mode === "legacy-agent" ? "messages" : "operator_messages"} SET body=? WHERE id=?`,
          )
          .run(body, first);
      for (const [id, date] of [
        [first, "2000-01-01"],
        [second, "2000-01-02"],
        [third, "2000-01-03"],
      ])
        for (const table of ["messages", "operator_messages"])
          f.coordinator.store.db
            .prepare(`UPDATE ${table} SET created_at=? WHERE id=?`)
            .run(date!, id!);
      const encoded = JSON.stringify({
        id: first,
        sender: null,
        message: body,
      }).length;
      assert.equal(encoded > 44000, legacy);
      await f.coordinator.start();
      assert.equal(f.runtime.starts, 1);
      assert.equal(f.runtime.inputs[0]?.includes(first), !legacy);
      assert.equal(f.runtime.inputs[0]?.includes(second), legacy);
      assert.deepEqual(
        f.coordinator.store.messages(f.root.id).map((m) => m.status),
        legacy
          ? ["rejected", "delivering", "delivering"]
          : ["delivering", "queued", "queued"],
      );
      assert.equal(f.coordinator.store.messages(f.root.id)[0]?.body, body);
      const finish = async (ids: string[], n: number) => {
        f.coordinator.store.acknowledge(
          f.coordinator.store.authenticate("thread-a", `fake-turn-${n}`, 1),
          ids,
        );
        f.runtime.emit("thread/tokenUsage/updated", {
          threadId: "thread-a",
          turnId: `fake-turn-${n}`,
          tokenUsage: { total: { totalTokens: 10 + n } },
        });
        f.runtime.emit("turn/completed", {
          threadId: "thread-a",
          turn: { id: `fake-turn-${n}`, status: "completed", items: [] },
        });
        await new Promise<void>((r) => setImmediate(r));
      };
      if (legacy) {
        assert.ok(f.runtime.inputs[0]?.includes(third));
        await finish([second, third], 1);
        assert.equal(f.runtime.starts, 1);
        const failure = f.coordinator.store
          .events(f.root.id)
          .find((e) => e.kind === "message.delivery_rejected");
        assert.ok(failure);
        assert.ok(JSON.stringify(failure).includes(first));
      } else {
        await finish([first], 1);
        assert.equal(f.runtime.starts, 2);
        assert.ok(f.runtime.inputs[1]?.includes(second));
        assert.ok(f.runtime.inputs[1]?.includes(third));
        await finish([second, third], 2);
        assert.equal(f.runtime.starts, 2);
      }
      assert.deepEqual(
        f.coordinator.store.messages(f.root.id).map((m) => m.status),
        legacy
          ? ["rejected", "processed", "processed"]
          : ["processed", "processed", "processed"],
      );
      assert.deepEqual(f.coordinator.diagnostics().errors, []);
      if (legacy) {
        await f.coordinator.stop();
        const reopened = new Store(
          join(f.coordinator.options.stateDirectory, "business.sqlite"),
        );
        try {
          assert.equal(reopened.messages(f.root.id)[0]?.status, "rejected");
          assert.equal(reopened.messages(f.root.id)[0]?.body, body);
          assert.equal(
            reopened
              .events(f.root.id)
              .filter((e) => e.kind === "message.delivery_rejected").length,
            1,
          );
        } finally {
          reopened.close();
        }
      }
    } finally {
      await f.close();
    }
  }
});

test("repeated recovery with empty history retains known or delayed Turn identity and queued messages without replay", async () => {
  for (const initial of ["starting", "running"] as const) {
    const f = fixture(initial);
    let current = f.coordinator;
    let runtime = f.runtime;
    const message = current.store.operatorSend(
      f.root.id,
      "queued",
      "pending report",
    );
    try {
      for (let n = 0; n < 3; n++) {
        await current.start();
        assert.equal(current.store.attempt(f.a.id).state, "unknown");
        assert.equal(
          current.store.attempt(f.a.id).turn_id,
          initial === "running" ? "native-turn" : null,
        );
        assert.equal(current.store.agent(f.root.id).reserved, 100);
        assert.equal(current.store.messages(f.root.id)[0]?.id, message);
        assert.equal(current.store.messages(f.root.id)[0]?.status, "queued");
        assert.equal(runtime.starts, 0);
        await current.stop();
        runtime = new FakeRuntime();
        current = new Coordinator(f.coordinator.options, runtime);
      }
      runtime.turns = [turn("native-turn", f.a.id, "completed")];
      await current.start();
      assert.equal(current.store.attempt(f.a.id).state, "completed");
      assert.equal(current.store.attempt(f.a.id).turn_id, "native-turn");
      assert.equal(current.store.messages(f.root.id)[0]?.status, "queued");
      assert.equal(
        current.store.budgetStatus(f.root.tree_id).unknownUsageAttempts.length,
        1,
      );
      assert.equal(runtime.starts, 0);
    } finally {
      await current.stop();
      await f.close();
    }
  }
});

test("a completion during history hydration cannot be overwritten by the stale in-progress snapshot or duplicate the Turn", async () => {
  const f = fixture("running");
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const reading = new Promise<void>((yes) => {
    entered = yes;
  });
  const gate = new Promise<void>((yes) => {
    release = yes;
  });
  const normalRead = f.runtime.readThread.bind(f.runtime);
  let firstRead = true;
  f.runtime.readThread = async () => {
    if (!firstRead) return normalRead();
    firstRead = false;
    const snapshot = {
      thread: {
        id: "thread-a",
        status: { type: "idle" },
        turns: [turn("native-turn", f.a.id, "inProgress")],
      },
    };
    entered();
    await gate;
    return snapshot;
  };
  try {
    f.coordinator.store.operatorSend(
      f.root.id,
      "next",
      "new work after completion",
    );
    const starting = f.coordinator.start();
    await reading;
    assert.equal(f.runtime.starts, 0);
    f.runtime.emit("thread/tokenUsage/updated", {
      threadId: "thread-a",
      turnId: "native-turn",
      tokenUsage: { total: { totalTokens: 10 } },
    });
    f.runtime.emit("turn/completed", {
      threadId: "thread-a",
      turn: turn("native-turn", f.a.id, "completed"),
    });
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "completed");
    release();
    await starting;
    assert.equal(f.coordinator.store.attempt(f.a.id).state, "completed");
    assert.equal(f.runtime.starts, 1);
    assert.equal(
      f.coordinator.store
        .attempts(f.root.id)
        .filter((a) => ["starting", "running", "unknown"].includes(a.state))
        .length,
      1,
    );
    assert.equal(f.coordinator.store.attempts(f.root.id).length, 2);
    assert.deepEqual(f.coordinator.diagnostics().errors, []);
  } finally {
    release();
    await f.close();
  }
});
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
