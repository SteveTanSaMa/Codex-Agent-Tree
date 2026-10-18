import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store, type Actor, type Agent } from "../../src/storage/store.ts";

const limits = {
  tokens: 10000,
  maxDepth: 2,
  maxAgents: 5,
  maxConcurrentTurns: 5,
  maxTurnsPerAgent: 8,
  turnReservation: 100,
};
function fixture() {
  const directory = mkdtempSync("/tmp/cat-tasks-");
  const path = join(directory, "business.sqlite");
  const store = new Store(path);
  const root = store.createRoot("A", "delegate", limits);
  const run = (agent: Agent): Actor => {
    const thread = `thread-${agent.id}`;
    store.bind(agent.id, thread, "test");
    const attempt = store.prepare(agent.id, "initial");
    store.markStarting(attempt.id);
    store.attachTurn(attempt.id, 1, `turn-${agent.id}`);
    return store.authenticate(thread, `turn-${agent.id}`, 1);
  };
  const a = run(root);
  const child = store.spawn(a, "B", {
    name: "B",
    role: "lead",
    task: "delegate",
    tokens: 3000,
  });
  const b = run(child);
  const leaf = store.spawn(b, "C", {
    name: "C",
    role: "worker",
    task: "work",
    tokens: 1000,
  });
  const c = run(leaf);
  const sibling = store.spawn(a, "D", {
    name: "D",
    role: "worker",
    task: "work",
    tokens: 2000,
  });
  const d = run(sibling);
  return {
    store,
    path,
    root,
    child,
    leaf,
    sibling,
    a,
    b,
    c,
    d,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const input = (key = "one") => ({
  requestKey: key,
  subject: "Calculate",
  description: "Calculate the supplied total",
});

test("task creation and CAS mutation are durable and retry identical keys without repeating effects", () => {
  const f = fixture();
  try {
    const task = f.store.tasks.create(f.a, f.root.id, input());
    assert.equal(task.ready, true);
    assert.equal(f.store.tasks.create(f.a, f.root.id, input()).id, task.id);
    assert.throws(
      () =>
        f.store.tasks.create(f.a, f.root.id, {
          ...input(),
          subject: "Changed",
        }),
      /changed content/,
    );
    const claim = {
      taskId: task.id,
      requestKey: "claim",
      expectedRevision: 1,
      action: "claim",
    };
    const claimed = f.store.tasks.update(f.b, f.child.id, claim);
    assert.equal(claimed.ownerId, f.child.id);
    assert.equal(claimed.revision, 2);
    assert.deepEqual(f.store.tasks.update(f.b, f.child.id, claim), claimed);
    assert.throws(
      () =>
        f.store.tasks.update(f.a, f.root.id, { ...claim, requestKey: "stale" }),
      /revision is 2/,
    );
    assert.throws(
      () =>
        f.store.tasks.update(f.b, f.child.id, { ...claim, action: "release" }),
      /changed content/,
    );
    const attempt = f.store.attempts(f.child.id)[0]!;
    f.store.observeUsage(attempt.id, 1, 10);
    f.store.finish(
      attempt.id,
      1,
      "completed",
      "Turn ended, but task is unfinished",
    );
    assert.equal(
      f.store.tasks.get(null, f.root.id, task.id).status,
      "in_progress",
    );
    const completed = f.store.tasks.update(null, f.root.id, {
      taskId: task.id,
      requestKey: "complete",
      expectedRevision: 2,
      action: "complete",
      result: "42",
    });
    assert.equal(completed.result, "42");
    f.store.close();
    const reopened = new Store(f.path);
    try {
      assert.equal(
        reopened.tasks.get(null, f.root.id, task.id).status,
        "completed",
      );
      assert.equal(
        reopened.tasks.update(null, f.root.id, {
          taskId: task.id,
          requestKey: "complete",
          expectedRevision: 2,
          action: "complete",
          result: "42",
        }).revision,
        3,
      );
      assert.equal(
        reopened.events(f.root.id).filter((e) => e.kind === "task.updated")
          .length,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test("task DAG validates claims, cycles, deletion and reopen without pretending to execute dependencies", () => {
  const f = fixture();
  try {
    const a = f.store.tasks.create(f.a, f.root.id, input("a"));
    const b = f.store.tasks.create(f.a, f.root.id, {
      ...input("b"),
      blockedBy: [a.id],
    });
    assert.equal(b.ready, false);
    assert.throws(
      () =>
        f.store.tasks.update(f.b, f.child.id, {
          taskId: b.id,
          requestKey: "blocked",
          expectedRevision: 1,
          action: "claim",
        }),
      /blocked/,
    );
    assert.throws(
      () =>
        f.store.tasks.update(f.a, f.root.id, {
          taskId: a.id,
          requestKey: "cycle",
          expectedRevision: 1,
          action: "set_dependencies",
          blockedBy: [b.id],
        }),
      /cycle/,
    );
    assert.throws(
      () =>
        f.store.tasks.create(f.a, f.root.id, {
          ...input("missing"),
          blockedBy: ["missing"],
        }),
      /missing/,
    );
    assert.throws(
      () =>
        f.store.tasks.create(f.a, f.root.id, {
          ...input("duplicate"),
          blockedBy: [a.id, a.id],
        }),
      /Duplicate/,
    );
    f.store.tasks.update(f.a, f.root.id, {
      taskId: a.id,
      requestKey: "claim",
      expectedRevision: 1,
      action: "claim",
    });
    f.store.tasks.update(f.a, f.root.id, {
      taskId: a.id,
      requestKey: "complete",
      expectedRevision: 2,
      action: "complete",
      result: "42",
    });
    assert.equal(f.store.tasks.get(f.b, f.child.id, b.id).ready, true);
    f.store.tasks.update(f.b, f.child.id, {
      taskId: b.id,
      requestKey: "claim-b",
      expectedRevision: 1,
      action: "claim",
    });
    assert.throws(
      () =>
        f.store.tasks.update(f.a, f.root.id, {
          taskId: a.id,
          requestKey: "reopen",
          expectedRevision: 3,
          action: "reopen",
        }),
      /dependents first/,
    );
    f.store.tasks.update(f.b, f.child.id, {
      taskId: b.id,
      requestKey: "release",
      expectedRevision: 2,
      action: "release",
    });
    f.store.tasks.update(f.a, f.root.id, {
      taskId: a.id,
      requestKey: "reopen",
      expectedRevision: 3,
      action: "reopen",
    });
    assert.equal(f.store.tasks.get(null, f.root.id, b.id).ready, false);
    assert.throws(
      () =>
        f.store.tasks.update(f.a, f.root.id, {
          taskId: a.id,
          requestKey: "delete-a",
          expectedRevision: 4,
          action: "delete",
        }),
      /deleted/,
    );
    f.store.tasks.update(f.a, f.root.id, {
      taskId: b.id,
      requestKey: "delete-b",
      expectedRevision: 3,
      action: "delete",
    });
    assert.equal(f.store.tasks.get(null, f.root.id, b.id).status, "deleted");
    assert.equal(f.store.tasks.list(null, f.root.id).length, 1);
    assert.equal(f.store.attempts().length, 4); // Task readiness itself creates no execution.
  } finally {
    f.close();
  }
});

test("task authority follows owner ancestry, rejects siblings and forged actors, and never clears human fences", () => {
  const f = fixture();
  try {
    const task = f.store.tasks.create(f.a, f.root.id, input());
    const update = (
      actor: Actor | null,
      revision: number,
      action: string,
      extra = {},
    ) =>
      f.store.tasks.update(actor, actor?.agentId ?? f.root.id, {
        taskId: task.id,
        requestKey: `${actor?.agentId ?? "human"}-${action}-${revision}`,
        expectedRevision: revision,
        action,
        ...extra,
      });
    update(f.a, 1, "assign", { ownerId: f.child.id });
    assert.throws(
      () => update(f.d, 2, "edit", { subject: "stolen" }),
      /ancestor/,
    );
    assert.throws(
      () => update(f.c, 2, "complete", { result: "forged" }),
      /ancestor/,
    );
    assert.throws(
      () => update({ ...f.a, agentId: f.child.id }, 2, "release"),
      /mismatch/,
    );
    update(f.b, 2, "assign", { ownerId: f.leaf.id });
    assert.throws(
      () => update(f.c, 3, "assign", { ownerId: f.sibling.id }),
      /subtree/,
    );
    f.store.control(null, f.leaf.id, "pause", "agent");
    update(f.c, 3, "edit", { description: "finish current drain safely" });
    assert.equal(f.store.agent(f.leaf.id).desired, "paused");
    f.store.control(null, f.leaf.id, "cancel", "agent");
    assert.throws(
      () => update(f.c, 4, "complete", { result: "cancelled" }),
      /cancellation/,
    );
    update(null, 4, "assign", { ownerId: f.sibling.id });
    assert.equal(f.store.agent(f.leaf.id).desired, "cancelled");
    const other = f.store.createRoot("other", "other", limits);
    assert.throws(
      () => f.store.tasks.list(f.a, other.id),
      /outside caller tree/,
    );
    const outside = f.store.tasks.create(null, other.id, input());
    assert.throws(
      () =>
        f.store.tasks.create(f.a, f.root.id, {
          ...input("foreign"),
          blockedBy: [outside.id],
        }),
      /outside the tree/,
    );
    assert.throws(
      () => f.store.tasks.get(f.a, f.root.id, outside.id),
      /not found/,
    );
  } finally {
    f.close();
  }
});

test("task path warnings are advisory and strict action schemas reject identity injection", () => {
  const f = fixture();
  try {
    const a = f.store.tasks.create(f.a, f.root.id, {
      ...input("a"),
      writeScopes: ["./src/api/"],
    });
    f.store.tasks.update(f.b, f.child.id, {
      taskId: a.id,
      requestKey: "claim-a",
      expectedRevision: 1,
      action: "claim",
    });
    const b = f.store.tasks.create(f.a, f.root.id, {
      ...input("b"),
      writeScopes: ["src\\api\\users.ts"],
    });
    assert.equal(b.writeScopeWarnings.length, 1);
    assert.equal(b.ready, true);
    for (const scope of ["../private", "/etc", "C:\\temp", "src/../private"])
      assert.throws(
        () =>
          f.store.tasks.create(f.a, f.root.id, {
            ...input(scope),
            writeScopes: [scope],
          }),
        /relative/,
      );
    assert.throws(
      () =>
        f.store.tasks.create(f.a, f.root.id, {
          ...input("spoof"),
          senderId: f.child.id,
        }),
      /Unknown/,
    );
    assert.throws(
      () =>
        f.store.tasks.update(f.b, f.child.id, {
          taskId: a.id,
          requestKey: "smuggle",
          expectedRevision: 2,
          action: "complete",
          result: "42",
          ownerId: f.sibling.id,
        }),
      /Arguments/,
    );
  } finally {
    f.close();
  }
});

test("task mutation rollback publishes no event and retries the same request after repair", async () => {
  const f = fixture();
  const abort = new AbortController();
  let woke = false;
  try {
    const cursor = f.store.eventCursor();
    const waiting = f.store.waitForCommit(abort.signal).then(() => {
      woke = true;
    });
    f.store.db.exec(
      "CREATE TRIGGER reject_task_event BEFORE INSERT ON events WHEN NEW.kind='task.created' BEGIN SELECT RAISE(ABORT,'injected task commit failure'); END",
    );
    assert.throws(
      () => f.store.tasks.create(f.a, f.root.id, input()),
      /injected/,
    );
    await Promise.resolve();
    assert.equal(woke, false);
    assert.equal(f.store.eventCursor(), cursor);
    assert.equal(f.store.tasks.list(null, f.root.id).length, 0);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM task_requests").get()?.n,
      0,
    );
    f.store.db.exec("DROP TRIGGER reject_task_event");
    f.store.tasks.create(f.a, f.root.id, input());
    await waiting;
    assert.equal(woke, true);
    assert.equal(f.store.tasks.list(null, f.root.id).length, 1);
  } finally {
    abort.abort();
    f.close();
  }
});

test("schema 4 upgrades to task storage without changing existing native identity, cost, or messages", () => {
  const f = fixture();
  try {
    const binding = f.store.binding(f.root.id);
    const budget = f.store.budgetStatus(f.root.tree_id);
    const message = f.store.operatorSend(f.root.id, "input", "keep queued");
    f.store.db.exec(
      "DROP TABLE task_requests; DROP TABLE task_scopes; DROP TABLE task_dependencies; DROP TABLE tasks; UPDATE schema_version SET version=4",
    );
    f.store.close();
    const reopened = new Store(f.path);
    try {
      assert.equal(
        reopened.db.prepare("SELECT version FROM schema_version").get()
          ?.version,
        13,
      );
      assert.deepEqual(reopened.binding(f.root.id), binding);
      assert.deepEqual(reopened.budgetStatus(f.root.tree_id), budget);
      assert.equal(reopened.messages(f.root.id)[0]?.id, message);
      assert.equal(reopened.tasks.create(null, f.root.id, input()).revision, 1);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test("soak task archival sustains more than 256 complete lifecycles without raising the live-task cap", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 300; i++) {
      let task = f.store.tasks.create(f.a, f.root.id, input(`soak-${i}`));
      for (const action of ["claim", "complete", "delete"]) {
        task = f.store.tasks.update(f.a, f.root.id, {
          taskId: task.id,
          requestKey: `soak-${i}-${action}`,
          expectedRevision: task.revision,
          action,
          ...(action === "complete" ? { result: "verified" } : {}),
        });
        assert.equal(
          task.status,
          action === "claim"
            ? "in_progress"
            : action === "complete"
              ? "completed"
              : "deleted",
        );
      }
    }
  } finally {
    f.close();
  }
});
