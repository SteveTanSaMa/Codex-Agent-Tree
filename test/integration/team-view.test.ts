import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";

const limits = {
  tokenPolicy: "enforce" as const,
  tokens: 10000,
  maxDepth: 2,
  maxAgents: 4,
  maxConcurrentTurns: 4,
  maxTurnsPerAgent: 8,
  turnReservation: 100,
};
async function settled() {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
}
async function fixture() {
  const directory = mkdtempSync("/tmp/cat-team-view-");
  const runtime = new ControlledRuntime();
  const coordinator = new Coordinator(
    {
      stateDirectory: directory,
      runtimeHome: join(directory, "native"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  await coordinator.start();
  const root = coordinator.createRoot("A", "initial task", limits);
  await settled();
  assert.equal(runtime.starts.length, 1);
  return {
    directory,
    runtime,
    coordinator,
    root,
    async close() {
      await coordinator.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("durable event cursors observe both earlier commits and a commit immediately after waiter registration", async () => {
  const f = await fixture();
  try {
    const before = f.coordinator.view(f.root.id).cursor;
    f.coordinator.store.note(f.root.id, "already.committed", {});
    const old = await f.coordinator.wait(f.root.id, before);
    assert.equal(old.reason, "changed");
    assert.equal(old.events[0]?.kind, "already.committed");
    const waiting = f.coordinator.wait(f.root.id, old.cursor);
    f.coordinator.store.tasks.create(null, f.root.id, {
      requestKey: "t",
      subject: "task",
      description: "work",
    });
    const result = await waiting;
    assert.equal(result.reason, "changed");
    assert.equal(result.events[0]?.kind, "task.created");
    assert.equal(result.view?.tasks.length, 1);
    assert.equal(f.runtime.starts.length, 1);
    assert.equal(result.view?.agents[0]?.execution, "running");
  } finally {
    await f.close();
  }
});

test("wait filters unrelated tree commits without extending its timeout or losing the wanted event", async () => {
  const f = await fixture();
  try {
    const other = f.coordinator.createRoot("other", "other", limits);
    await settled();
    const after = f.coordinator.view(f.root.id).cursor;
    let returned = false;
    const waiting = f.coordinator.wait(f.root.id, after, 1000).then((v) => {
      returned = true;
      return v;
    });
    f.coordinator.store.note(other.id, "foreign.change", {});
    await settled();
    assert.equal(returned, false);
    f.coordinator.store.note(f.root.id, "wanted.change", {});
    const result = await waiting;
    assert.equal(result.reason, "changed");
    assert.deepEqual(
      result.events.map((e) => e.kind),
      ["wanted.change"],
    );
    assert.equal(result.view?.treeId, f.root.tree_id);
  } finally {
    await f.close();
  }
});

test("wait reports timeout, validates future cursors and bounds, and cancels on client disconnect or stop", async () => {
  const f = await fixture();
  try {
    const cursor = f.coordinator.view(f.root.id).cursor;
    assert.equal(
      (await f.coordinator.wait(f.root.id, cursor, 15)).reason,
      "timedOut",
    );
    await assert.rejects(f.coordinator.wait(f.root.id, cursor + 999), /ahead/);
    await assert.rejects(
      f.coordinator.wait(f.root.id, cursor, 30001),
      /at most/,
    );
    const abandoned = new AbortController();
    const waiting = f.coordinator.wait(
      f.root.id,
      cursor,
      1000,
      abandoned.signal,
    );
    abandoned.abort(new Error("client disconnected"));
    await assert.rejects(waiting, /client disconnected/);
    const stopped = f.coordinator.wait(f.root.id, cursor);
    await f.coordinator.stop();
    assert.equal((await stopped).reason, "stopped");
  } finally {
    await f.close();
  }
});

test("task readiness and idle completion never dispatch work; view explains no-progress and preserves fences", async () => {
  const f = await fixture();
  try {
    const task = f.coordinator.store.tasks.create(null, f.root.id, {
      requestKey: "t",
      subject: "task",
      description: "not dispatched",
    });
    f.runtime.complete();
    await settled();
    const view = f.coordinator.view(f.root.id);
    assert.equal(view.tasks[0]?.status, "pending");
    assert.equal(view.agents[0]?.execution, "idle");
    assert.equal(view.progressPossible, false);
    assert.equal(f.runtime.starts.length, 1);
    assert.equal(
      (await f.coordinator.wait(f.root.id, view.cursor)).reason,
      "noProgress",
    );
    await f.coordinator.control(f.root.id, "pause", "agent");
    f.coordinator.store.tasks.update(null, f.root.id, {
      taskId: task.id,
      requestKey: "claim",
      expectedRevision: 1,
      action: "claim",
    });
    const paused = f.coordinator.view(f.root.id);
    assert.ok(paused.reasons.some((r) => r.code === "paused"));
    assert.equal(paused.progressPossible, false);
    assert.equal(f.runtime.starts.length, 1);
  } finally {
    await f.close();
  }
});

test("event pages preserve a cursor across service restart, and task tools authenticate actual Native calls", async () => {
  const f = await fixture();
  let replacement: Coordinator | undefined;
  try {
    const start = f.runtime.starts[0]!;
    f.runtime.onRequest({
      id: "create",
      connectionGeneration: 1,
      method: "item/tool/call",
      params: {
        threadId: start.threadId,
        turnId: start.turnId,
        tool: "agent_task_create",
        arguments: {
          requestKey: "actual-tool",
          subject: "task",
          description: "actual trusted caller",
        },
      },
    });
    await settled();
    const response = f.runtime.responses[0] as {
      success: boolean;
      contentItems: { text: string }[];
    };
    assert.equal(response.success, true);
    const task = JSON.parse(response.contentItems[0]!.text) as { id: string };
    assert.equal(
      f.coordinator.store.tasks.get(null, f.root.id, task.id).createdBy,
      f.root.id,
    );
    const cursor = f.coordinator.view(f.root.id).cursor;
    for (let i = 0; i < 105; i++)
      f.coordinator.store.note(f.root.id, "page", { i });
    const page = await f.coordinator.wait(f.root.id, cursor);
    assert.equal(page.events.length, 100);
    assert.equal(page.hasMore, true);
    const next = await f.coordinator.wait(f.root.id, page.cursor);
    assert.equal(next.events.length, 5);
    assert.equal(next.hasMore, false);
    f.runtime.complete();
    await settled();
    const last = f.coordinator.view(f.root.id).cursor;
    await f.coordinator.stop();
    replacement = new Coordinator(
      f.coordinator.options,
      new ControlledRuntime(),
    );
    await replacement.start();
    assert.equal(replacement.view(f.root.id).cursor, last);
    assert.equal(
      (await replacement.wait(f.root.id, page.cursor)).reason,
      "changed",
    );
    assert.equal(replacement.view(f.root.id).tasks[0]?.id, task.id);
  } finally {
    await replacement?.stop();
    await f.close();
  }
});

test("view does not charge a prepared Turn reservation twice when diagnosing progress", async () => {
  const f = await fixture();
  try {
    const root = f.coordinator.store.createRoot("prepared", "work", {
      ...limits,
      tokens: 100,
    });
    f.coordinator.store.bind(root.id, "prepared-thread", "fixture");
    f.coordinator.store.prepare(root.id, "prepared input", null, null, []);
    const view = f.coordinator.view(root.id);
    assert.equal(view.budget.availableTokens, 0);
    assert.equal(view.agents[0]?.execution, "prepared");
    assert.equal(view.progressPossible, true);
    assert.equal(
      (await f.coordinator.wait(root.id, view.cursor, 0)).reason,
      "timedOut",
    );
  } finally {
    await f.close();
  }
});
