/** Compare the review baseline with current projection. No model or user-state access. */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Store } from "../../src/storage/store.ts";
import { TaskBoard } from "../../src/storage/task-board.ts";
const root = fileURLToPath(new URL("../../", import.meta.url)),
  dir = mkdtempSync("/tmp/cat-project-bench-");
const s = new Store(join(dir, "s.sqlite"));
try {
  const a = s.createRoot("Lead", "fixture", {
    tokenPolicy: "observe",
    tokens: 1000,
    maxDepth: 0,
    maxAgents: 1,
    maxConcurrentTurns: 1,
    maxTurnsPerAgent: 1,
    turnReservation: 100,
  });
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src/storage/task-board.ts"),
    execFileSync("git", ["show", "ee84ea1:src/storage/task-board.ts"], {
      cwd: root,
    }),
  );
  const baseline = await import(
    pathToFileURL(join(dir, "src/storage/task-board.ts")).href
  );
  const context = {
    db: s.db,
    agent: () => a,
    authenticate: () => a,
    subtree: () => [a],
    event: () => {},
    transact: <T>(f: () => T) => f(),
  };
  const old = new baseline.TaskBoard(context) as TaskBoard,
    now = new TaskBoard(context);
  for (const density of ["sparse", "dense"]) {
    s.db.exec(
      "DELETE FROM task_dependencies;DELETE FROM task_scopes;DELETE FROM tasks;BEGIN",
    );
    for (let i = 0; i < 256; i++) {
      const id = "t" + String(i).padStart(3, "0");
      s.db
        .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          a.tree_id,
          a.id,
          null,
          1,
          i % 3 === 0 ? "in_progress" : i % 3 === 1 ? "pending" : "completed",
          id,
          "fixture",
          null,
          "same",
          "same",
        );
      for (let j = 0; j < 16; j++)
        s.db
          .prepare("INSERT INTO task_scopes VALUES(?,?)")
          .run(
            id,
            density === "dense" ? `src/shared/${j}` : `src/m${i % 64}/f${j}`,
          );
      for (let j = Math.max(0, i - 16); j < i; j++)
        s.db
          .prepare("INSERT INTO task_dependencies VALUES(?,?)")
          .run(id, "t" + String(j).padStart(3, "0"));
    }
    s.db.exec("COMMIT");
    const before = old.list(null, a.id),
      after = now.list(null, a.id);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Projection output differs");
    const measure = (board: TaskBoard) => {
      const values = [];
      for (let i = 0; i < 15; i++) {
        const start = performance.now();
        board.list(null, a.id);
        if (i >= 5) values.push(performance.now() - start);
      }
      return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    };
    const baselineMs = measure(old),
      currentMs = measure(now);
    console.log(
      JSON.stringify({
        density,
        tasks: 256,
        scopes: 4096,
        warmups: 5,
        samples: 10,
        baselineMedianMs: baselineMs,
        currentMedianMs: currentMs,
        speedup: baselineMs / currentMs,
        identicalOutput: true,
      }),
    );
  }
} finally {
  s.close();
  rmSync(dir, { recursive: true, force: true });
}
