import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync("/tmp/cat-growth-");
const store = new Store(join(dir, "state.sqlite"));
try {
  const root = store.createRoot("Lead", "benchmark", rootSettings({}).limits);
  const insert = store.db.prepare(
    "INSERT INTO tasks VALUES(?,?,?,NULL,1,'completed','history','evidence','done',?,?)",
  );
  const attemptInsert = store.db.prepare(
    "INSERT INTO turn_attempts(id,agent_id,thread_id,binding_generation,owner_generation,turn_id,state,input,trace_id,reserved,created_at) VALUES(?,?,'bench-thread',1,1,?,'completed',?,'bench',0,'2026-01-01')",
  );
  const messageInsert = store.db.prepare(
    "INSERT INTO messages(id,sender_id,recipient_id,body,status,created_at) VALUES(?,?,?,?,'processed','2026-01-01')",
  );
  let previous = 0;
  const output = [];
  for (const size of [100, 1000, 5000]) {
    store.db.exec("BEGIN");
    for (let i = previous; i < size; i++)
      insert.run(
        "task-" + i,
        root.tree_id,
        root.id,
        "2026-01-01",
        "2026-01-01",
      );
    for (let i = previous; i < size; i++) {
      attemptInsert.run("attempt-" + i, root.id, "turn-" + i, "x".repeat(2000));
      messageInsert.run("message-" + i, root.id, root.id, "x".repeat(2000));
    }
    store.db.exec("COMMIT");
    previous = size;
    const bench = (fn: () => unknown) => {
      const ms = [];
      for (let n = 0; n < 9; n++) {
        const t = performance.now();
        fn();
        ms.push(performance.now() - t);
      }
      return ms.sort((a, b) => a - b)[4];
    };
    let observed = "";
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql: string) => {
      if (sql.startsWith("WITH RECURSIVE")) observed = sql;
      return prepare(sql);
    };
    store.tasks.get(null, root.id, "task-0");
    store.db.prepare = prepare;
    const plan = observed
      ? prepare("EXPLAIN QUERY PLAN " + observed).all(
          root.tree_id,
          '["task-0"]',
          root.tree_id,
          root.tree_id,
        )
      : [];
    output.push({
      queryPlan: plan,
      legacyAttemptReadMs: bench(() =>
        store
          .attempts(root.id)
          .filter((a) =>
            ["prepared", "starting", "running", "unknown"].includes(a.state),
          ),
      ),
      indexedAttemptReadMs: bench(() => store.unsettledAttempts(root.id)),
      legacyMessageReadMs: bench(() =>
        store.messages(root.id).filter((m) => m.status === "queued"),
      ),
      indexedMessageReadMs: bench(() => store.pendingMessages(root.id)),
      size,
      getMedianMs: bench(() => store.tasks.get(null, root.id, "task-0")),
      createMedianMs: bench(() => {
        let t;
        try {
          t = store.tasks.create(null, root.id, {
            requestKey: "bench-" + size + "-" + Math.random(),
            subject: "active",
            description: "benchmark",
          });
        } catch {
          return;
        }
        store.tasks.update(null, root.id, {
          requestKey: "delete-" + t.id,
          taskId: t.id,
          expectedRevision: t.revision,
          action: "delete",
        });
      }),
    });
  }
  console.log(JSON.stringify(output, null, 2));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
