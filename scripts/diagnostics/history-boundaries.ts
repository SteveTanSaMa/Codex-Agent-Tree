import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { capacity, historyExport } from "../../src/cli/maintenance.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const directory = mkdtempSync("/tmp/cat-boundaries-");
const results = [];
try {
  for (const size of [100, 1000, 5000]) {
    const state = join(directory, String(size)),
      s = new Store(join(state, "business.sqlite"));
    try {
      const root = s.createRoot("Lead", "benchmark", rootSettings({}).limits);
      s.db.exec("BEGIN");
      const task = s.db.prepare(
          "INSERT INTO tasks VALUES(?,?,?,NULL,1,'completed','history','retained','done','2026-01-01','2026-01-01')",
        ),
        dep = s.db.prepare("INSERT INTO task_dependencies VALUES(?,?)");
      for (let i = 0; i < size; i++) {
        task.run("t" + i, root.tree_id, root.id);
        if (i) dep.run("t" + i, "t" + (i - 1));
      }
      s.db.exec(
        "INSERT INTO task_archives SELECT id,'2026-01-01' FROM tasks;COMMIT",
      );
      const timings: Record<string, unknown> = {};
      const measure = (name: string, fn: () => unknown) => {
        const samples = [];
        try {
          for (let i = 0; i < 5; i++) {
            const at = performance.now();
            fn();
            samples.push(performance.now() - at);
          }
          timings[name] = { medianMs: samples.sort((a, b) => a - b)[2] };
        } catch (error) {
          timings[name] = { error: String(error) };
        }
      };
      measure("legacyFullList", () => s.tasks.list(null, root.id));
      measure("historyPage50", () => s.tasks.page(null, root.id, 0, 50, true));
      measure("dependencyClosureGet", () =>
        s.tasks.get(null, root.id, "t" + (size - 1)),
      );
      measure("capacity", () => capacity(state));
      measure("auditExport50", () =>
        historyExport(state, root.id, "events", 0, 50),
      );
      let created;
      const at = performance.now();
      try {
        created = s.tasks.create(null, root.id, {
          requestKey: "dependent",
          subject: "active",
          description: "must validate entire retained chain",
          blockedBy: ["t" + (size - 1)],
        });
        timings.createWithClosure = {
          ms: performance.now() - at,
          ready: created.ready,
        };
      } catch (error) {
        timings.createWithClosure = { error: String(error) };
      }
      if (created)
        measure("activeBoardWithClosure", () =>
          s.tasks.activeList(null, root.id),
        );
      results.push({
        historicalTasks: size,
        retainedDependencies: size - 1,
        timings,
      });
    } finally {
      s.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
