import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store, type Agent } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";

async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, "fixture did not settle");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function fixture() {
  const dir = mkdtempSync("/tmp/cat-work-scope-");
  const store = new Store(join(dir, "business.sqlite"));
  const root = store.createRoot(
    "Lead",
    "OLD_ASSIGNMENT",
    rootSettings({ concurrent: 3 }).limits,
  );
  function active(agent: Agent) {
    const b = store.bind(agent.id, `thread-${agent.id}`, "fixture");
    const t = store.prepare(agent.id, agent.task);
    store.markStarting(t.id);
    store.attachTurn(t.id, b.generation, `turn-${t.id}`);
    return {
      attempt: store.attempt(t.id),
      actor: store.authenticate(b.thread_id, `turn-${t.id}`, b.generation),
    };
  }
  return {
    dir,
    store,
    root,
    active,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("replacement atomically withdraws subtree work and rejects old Turn authority without inventing completion", () => {
  const f = fixture();
  try {
    const r = f.active(f.root);
    const child = f.store.spawn(r.actor, "child", {
      name: "Child",
      role: "worker",
      task: "OLD_CHILD",
    });
    const c = f.active(child);
    const leaf = f.store.spawn(c.actor, "leaf", {
      name: "Leaf",
      role: "review",
      task: "OLD_LEAF",
    });
    f.store.bind(leaf.id, "thread-leaf", "fixture");
    const prepared = f.store.prepare(leaf.id, "OLD_LEAF");
    f.store.send(c.actor, "old-report", f.root.id, "OLD_REPORT");
    f.store.operatorSend(child.id, "old-human", "OLD_CHILD_INPUT");
    const task = f.store.tasks.create(c.actor, child.id, {
      requestKey: "task",
      subject: "Old",
      description: "Old work",
    });
    f.store.beginWorkspaceCommand(c.actor, "command", { command: "effect" });
    const p = f.store.scopes.replace(f.root.id, "replace", 0, "NEW_ASSIGNMENT");
    assert.equal(p.state, "draining");
    assert.equal(p.attempts.length, 2);
    assert.equal(p.commands.length, 1);
    assert.equal(f.store.attempt(prepared.id).state, "cancelled");
    assert.equal(f.store.agent(leaf.id).reserved, 0);
    assert.equal(f.store.scopes.epoch(leaf.id).initialEnabled, false);
    assert.ok(
      f.store.messages(child.id).every((m) => m.status === "cancelled"),
    );
    assert.equal(f.store.messages(f.root.id)[0]!.status, "cancelled");
    assert.equal(f.store.tasks.get(null, child.id, task.id).status, "deleted");
    assert.throws(
      () =>
        f.store.tasks.update(null, child.id, {
          requestKey: "edit-old",
          taskId: task.id,
          expectedRevision: 2,
          action: "edit",
          subject: "revive",
        }),
      /withdrawn/,
    );
    for (const actor of [r.actor, c.actor]) {
      assert.throws(
        () => f.store.send(actor, "late", f.root.id, "LATE"),
        /withdrawn/,
      );
      assert.throws(
        () =>
          f.store.spawn(actor, "late-child", {
            name: "Late",
            role: "worker",
            task: "late",
          }),
        /withdrawn/,
      );
      assert.throws(
        () => f.store.beginWorkspaceCommand(actor, "late-command", {}),
        /withdrawn/,
      );
    }
    const retry = f.store.scopes.replace(
      f.root.id,
      "replace",
      0,
      "NEW_ASSIGNMENT",
    );
    assert.deepEqual(retry.receipt, p.receipt);
    assert.throws(
      () => f.store.scopes.replace(f.root.id, "replace", 0, "changed"),
      /changed content/,
    );
    assert.throws(
      () => f.store.scopes.replace(f.root.id, "second", 0, "changed"),
      /generation changed/,
    );
    for (const t of [r.attempt, c.attempt])
      f.store.finish(t.id, 1, "completed", "old result");
    f.store.scopes.advance();
    assert.equal(
      f.store.scopes.progress(p.receipt.id).state,
      "draining",
      "unknown command cannot be hidden by Turn completion",
    );
    f.store.finishWorkspaceCommand(child.id, "command", { exitCode: 0 });
    f.store.scopes.advance();
    assert.equal(f.store.scopes.progress(p.receipt.id).state, "ready");
    assert.equal(f.store.agent(f.root.id).turns, 1);
    assert.equal(f.store.agent(child.id).turns, 1);
  } finally {
    f.close();
  }
});

test("replacing a child cancels its queued cross-branch report but preserves unrelated queued work", () => {
  const f = fixture();
  try {
    const r = f.active(f.root);
    const child = f.store.spawn(r.actor, "child", {
      name: "Child",
      role: "worker",
      task: "old",
    });
    const c = f.active(child);
    f.store.send(c.actor, "report", f.root.id, "old child report");
    f.store.operatorSend(f.root.id, "independent", "unrelated root work");
    f.store.scopes.replace(child.id, "replace-child", 0, "new child work");
    assert.deepEqual(
      f.store.messages(f.root.id).map((m) => m.status),
      ["cancelled", "queued"],
    );
    assert.equal(f.store.scopes.epoch(f.root.id).generation, 0);
    assert.doesNotThrow(() =>
      f.store.authenticate(r.actor.threadId, r.actor.turnId, 1),
    );
  } finally {
    f.close();
  }
});

test("managed status/list/control omit queued bodies; operator diagnostics retain them", async () => {
  const dir = mkdtempSync("/tmp/cat-scope-projection-");
  const runtime = new ControlledRuntime();
  const c = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "h"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await c.start();
    const root = c.createRoot(
      "Lead",
      "PRIVATE_ASSIGNMENT",
      rootSettings({}).limits,
    );
    await until(() => runtime.starts.length === 1);
    const running = c.store.activeAttempt(root.id)!;
    c.store.updateResult(
      running.id,
      running.binding_generation,
      "Z".repeat(60000),
    );
    c.store.operatorSend(root.id, "private-input", "QUEUED_SECRET_BODY");
    assert.match(JSON.stringify(c.status(root.id)), /QUEUED_SECRET_BODY/);
    for (const [tool, args] of [
      ["agent_status", {}],
      ["agent_list", {}],
      ["agent_control", { target: root.id, action: "pause" }],
    ] as const) {
      const count = runtime.responses.length;
      runtime.onRequest({
        id: tool,
        connectionGeneration: 1,
        method: "item/tool/call",
        params: {
          threadId: runtime.starts[0]!.threadId,
          turnId: runtime.starts[0]!.turnId,
          callId: tool,
          tool,
          arguments: args,
        },
      });
      await until(() => runtime.responses.length > count);
      assert.doesNotMatch(
        JSON.stringify(runtime.responses.at(-1)),
        /QUEUED_SECRET_BODY|PRIVATE_ASSIGNMENT/,
      );
      assert.match(
        JSON.stringify(runtime.responses.at(-1)),
        /toolContractVersion/,
      );
      const reply = runtime.responses.at(-1) as {
        contentItems: { text: string }[];
      };
      const value = JSON.parse(reply.contentItems[0]!.text);
      for (const status of Array.isArray(value) ? value : [value]) {
        assert.equal(status.attempts[0].result.length, 2000);
        assert.equal(status.attempts[0].resultTruncated, true);
      }
    }
  } finally {
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacement waits for native settlement, dispatches only new input, parks never-started descendants and preserves pause", async () => {
  const dir = mkdtempSync("/tmp/cat-scope-coordinator-");
  const runtime = new ControlledRuntime();
  const c = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "h"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await c.start();
    const root = c.createRoot("Lead", "OLD_ROOT", rootSettings({}).limits);
    await until(() => runtime.starts.length === 1);
    const t = c.store.attempts(root.id)[0]!;
    const child = c.store.spawn(
      c.store.authenticate(t.thread_id, t.turn_id!, 1),
      "child",
      { name: "Child", role: "worker", task: "OLD_CHILD" },
    );
    await c.control(root.id, "pause");
    const p = await c.replaceScope(root.id, "replacement", 0, "NEW_ROOT");
    assert.equal(p.state, "draining");
    runtime.complete(0);
    await until(() => c.store.scopes.progress(p.receipt.id).state === "ready");
    assert.equal(
      runtime.starts.length,
      1,
      "human pause must survive replacement",
    );
    await c.control(root.id, "resume");
    await until(() => runtime.starts.length === 2);
    assert.match(runtime.starts[1]!.input, /NEW_ROOT/);
    assert.doesNotMatch(runtime.starts[1]!.input, /OLD_ROOT|OLD_CHILD/);
    assert.equal(c.store.attempts(child.id).length, 0);
    const next = c.store.attempts(root.id).find((a) => a.state === "running")!;
    assert.doesNotThrow(() =>
      c.store.authenticate(next.thread_id, next.turn_id!, 1),
    );
  } finally {
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema 12 scope migration preserves legacy authority, pending work and counters exactly once", () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const t = f.active(f.root);
    f.store.operatorSend(f.root.id, "pending", "input");
    f.store.db.exec(
      "DROP TABLE scope_invalid_tasks; DROP TABLE scope_members; DROP TABLE scope_replacements; DROP TABLE work_refs; DROP TABLE work_epochs; UPDATE schema_version SET version=12",
    );
    f.store.close();
    reopened = new Store(join(f.dir, "business.sqlite"));
    assert.equal(
      reopened.db.prepare("SELECT version FROM schema_version").get()!.version,
      14,
    );
    assert.equal(reopened.agent(f.root.id).turns, 1);
    assert.equal(reopened.messages(f.root.id)[0]!.status, "queued");
    assert.doesNotThrow(() =>
      reopened!.authenticate(t.actor.threadId, t.actor.turnId, 1),
    );
    reopened.scopes.replace(f.root.id, "new", 0, "new work");
    reopened.close();
    reopened = new Store(join(f.dir, "business.sqlite"));
    assert.equal(reopened.scopes.epoch(f.root.id).generation, 1);
    assert.throws(
      () => reopened!.authenticate(t.actor.threadId, t.actor.turnId, 1),
      /withdrawn/,
    );
  } finally {
    reopened?.close();
    f.close();
  }
});

test("replacement during an awaited preflight cannot dispatch a stale initial assignment", async () => {
  const dir = mkdtempSync("/tmp/cat-scope-preflight-");
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  class Runtime extends ControlledRuntime {
    override async readThread(id: string) {
      entered = true;
      await gate;
      return super.readThread(id);
    }
  }
  const runtime = new Runtime();
  const c = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "h"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await c.start();
    const root = c.createRoot("Lead", "STALE_INITIAL", rootSettings({}).limits);
    await until(() => entered);
    const result = await c.replaceScope(
      root.id,
      "new",
      0,
      "CURRENT_ASSIGNMENT",
    );
    assert.equal(result.state, "ready");
    release();
    await until(() => runtime.starts.length === 1);
    assert.match(runtime.starts[0]!.input, /CURRENT_ASSIGNMENT/);
    assert.doesNotMatch(runtime.starts[0]!.input, /STALE_INITIAL/);
  } finally {
    release();
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacement during accepted start with held ACK interrupts once its ID becomes observable", async () => {
  const dir = mkdtempSync("/tmp/cat-scope-start-");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  class Runtime extends ControlledRuntime {
    interrupts: string[] = [];
    override async startTurn(thread: string, input: string, attempt: string) {
      const id = await super.startTurn(thread, input, attempt);
      if (this.starts.length === 1) await gate;
      return id;
    }
    override async interrupt(_thread?: string, turn?: string) {
      this.interrupts.push(turn!);
    }
  }
  const runtime = new Runtime();
  const c = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "h"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await c.start();
    const root = c.createRoot("Lead", "old", rootSettings({}).limits);
    await until(() => runtime.starts.length === 1);
    const result = await c.replaceScope(root.id, "new", 0, "new assignment");
    assert.equal(result.state, "draining");
    assert.equal(runtime.interrupts.length, 0);
    release();
    await until(() => runtime.interrupts.length === 1);
    assert.equal(runtime.interrupts[0], runtime.starts[0]!.turnId);
    assert.equal(runtime.starts.length, 1);
    runtime.complete(0);
    await until(() => runtime.starts.length === 2);
    assert.match(runtime.starts[1]!.input, /new assignment/);
  } finally {
    release();
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withdrawn guidance cannot be deferred or manually retried back into a new scope", () => {
  const f = fixture();
  try {
    const t = f.active(f.root);
    const id = f.store.operatorSend(f.root.id, "old-guidance", "old");
    f.store.interaction.register(f.root.id, id, "steer");
    f.store.interaction.claim(id, t.attempt);
    f.store.scopes.replace(f.root.id, "replace", 0, "new");
    f.store.interaction.settle(id, "unknown", "ACK lost");
    assert.throws(
      () => f.store.interaction.resolve(f.root.id, id, "retry-next", "review"),
      /Withdrawn/,
    );
    assert.equal(f.store.messages(f.root.id)[0]!.status, "unknown");
    f.store.interaction.resolve(
      f.root.id,
      id,
      "delivered",
      "inspected native history; never replay",
    );
    assert.notEqual(f.store.messages(f.root.id)[0]!.status, "queued");
  } finally {
    f.close();
  }
});

test("operator command review retains an unknown outcome and only releases the scope after native settlement", () => {
  const f = fixture();
  try {
    const t = f.active(f.root);
    f.store.beginWorkspaceCommand(t.actor, "unknown-effect", {
      effect: "fixture",
    });
    const p = f.store.scopes.replace(f.root.id, "replace", 0, "new");
    assert.throws(
      () =>
        f.store.reviewUnknownCommand(f.root.id, "unknown-effect", "inspected"),
      /Reconcile/,
    );
    f.store.finish(t.attempt.id, 1, "interrupted", "interrupted");
    const review = f.store.reviewUnknownCommand(
      f.root.id,
      "unknown-effect",
      "inspected filesystem and stopped process",
    );
    assert.equal(review.outcome, "reviewed-unknown");
    assert.equal(review.replayAllowed, false);
    assert.deepEqual(
      f.store.reviewUnknownCommand(f.root.id, "unknown-effect", review.reason),
      review,
    );
    assert.throws(
      () =>
        f.store.reviewUnknownCommand(f.root.id, "unknown-effect", "different"),
      /changed reason/,
    );
    f.store.scopes.advance();
    assert.equal(f.store.scopes.progress(p.receipt.id).state, "ready");
    assert.equal(
      f.store.db
        .prepare("SELECT state FROM workspace_commands WHERE agent_id=?")
        .get(f.root.id)!.state,
      "reviewed-unknown",
    );
    assert.equal(f.store.accounting(t.attempt.id).finalized, false);
  } finally {
    f.close();
  }
});

test("withdrawing a Task leaves outside dependents diagnosable and permits unrelated graph edits", () => {
  const f = fixture();
  try {
    const r = f.active(f.root);
    const child = f.store.spawn(r.actor, "child", {
      name: "Child",
      role: "worker",
      task: "old",
    });
    const c = f.active(child);
    const old = f.store.tasks.create(c.actor, child.id, {
      requestKey: "old",
      subject: "Old",
      description: "old",
    });
    const dependent = f.store.tasks.create(r.actor, f.root.id, {
      requestKey: "dependent",
      subject: "Dependent",
      description: "outside work",
      blockedBy: [old.id],
    });
    const p = f.store.scopes.replace(child.id, "new", 0, "new work");
    assert.equal(
      f.store.tasks.get(null, f.root.id, old.id).withdrawnBy,
      p.receipt.id,
    );
    assert.equal(f.store.tasks.get(null, f.root.id, dependent.id).ready, false);
    assert.doesNotThrow(() =>
      f.store.tasks.create(r.actor, f.root.id, {
        requestKey: "unrelated",
        subject: "New",
        description: "unrelated",
      }),
    );
    const updated = f.store.tasks.update(r.actor, f.root.id, {
      requestKey: "clear-blocker",
      taskId: dependent.id,
      expectedRevision: dependent.revision,
      action: "set_dependencies",
      blockedBy: [],
    });
    assert.equal(updated.ready, true);
  } finally {
    f.close();
  }
});

test("retrying a ready replacement does not cancel newer-scope host commands", async () => {
  const dir = mkdtempSync("/tmp/cat-scope-retry-");
  const runtime = new ControlledRuntime();
  const c = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "h"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await c.start();
    const root = c.createRoot("Lead", "old", rootSettings({}).limits);
    await until(() => runtime.starts.length === 1);
    const receipt = await c.replaceScope(root.id, "replace", 0, "new");
    runtime.complete(0);
    await until(() => runtime.starts.length === 2);
    let cancellations = 0;
    // The spy models the host cancellation boundary without executing a shell.
    Object.defineProperty(c, "workspace", {
      value: {
        cancel() {
          cancellations++;
        },
      },
    });
    const retry = await c.replaceScope(root.id, "replace", 0, "new");
    assert.deepEqual(retry.receipt, receipt.receipt);
    assert.equal(retry.state, "ready");
    assert.equal(cancellations, 0);
    assert.equal(runtime.starts.length, 2);
  } finally {
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
