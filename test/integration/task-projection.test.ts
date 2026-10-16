import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/storage/store.ts";

test("indexed task projection matches pairwise readiness/scope oracle with 256 tasks, tombstones and prefix boundaries", () => {
  const dir = mkdtempSync("/tmp/cat-projection-"),
    s = new Store(join(dir, "s.sqlite"));
  try {
    const root = s.createRoot("Lead", "fixture", {
      tokenPolicy: "observe",
      tokens: 1000,
      maxDepth: 0,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 1,
      turnReservation: 100,
    });
    const scopes = [
      "src/a",
      "src/a/file.ts",
      "src/ab",
      "src",
      "Src/a",
      "test",
      "test/a",
      "docs/a",
      "docs/ab",
      "docs",
    ];
    const tasks = Array.from({ length: 256 }, (_, i) => ({
      id: "task-" + String(i).padStart(3, "0"),
      status: ["pending", "in_progress", "completed", "deleted"][i % 4]!,
      writeScopes: [
        ...new Set([
          scopes[i % scopes.length]!,
          scopes[(i * 7 + 3) % scopes.length]!,
        ]),
      ].sort(),
      blockedBy: i >= 3 ? ["task-" + String(i - 3).padStart(3, "0")] : [],
    }));
    const insert = s.db.prepare(
      "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    const dep = s.db.prepare("INSERT INTO task_dependencies VALUES(?,?)"),
      scope = s.db.prepare("INSERT INTO task_scopes VALUES(?,?)");
    s.db.exec("BEGIN");
    for (const t of tasks) {
      insert.run(
        t.id,
        root.tree_id,
        root.id,
        null,
        1,
        t.status,
        t.id,
        "fixture",
        null,
        "same-time",
        "same-time",
      );
      for (const d of t.blockedBy) dep.run(t.id, d);
      for (const p of t.writeScopes) scope.run(t.id, p);
    }
    s.db.exec("COMMIT");
    const projected = s.tasks.list(null, root.id);
    assert.equal(
      projected.length,
      tasks.filter((t) => t.status !== "deleted").length,
    );
    for (const t of tasks) {
      const actual = s.tasks.get(null, root.id, t.id);
      assert.deepEqual(actual.blockedBy, t.blockedBy);
      assert.deepEqual(actual.writeScopes, t.writeScopes);
      assert.equal(
        actual.ready,
        t.status === "pending" &&
          t.blockedBy.every(
            (id) =>
              tasks.find((other) => other.id === id)?.status === "completed",
          ),
      );
      const conflicts = tasks.filter(
        (other) =>
          other.id !== t.id &&
          other.status === "in_progress" &&
          t.writeScopes.some((a) =>
            other.writeScopes.some(
              (b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/"),
            ),
          ),
      );
      assert.deepEqual(
        actual.writeScopeWarnings,
        conflicts.map(
          (other) => `Write scopes overlap with ${other.id}; advisory only`,
        ),
      );
    }
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
