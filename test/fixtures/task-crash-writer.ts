import { Store } from "../../src/storage/store.ts";
const path = process.argv[2]!;
const store = new Store(path);
const root = store.createRoot("A", "persistent task owner", {
  tokens: 1000,
  maxDepth: 1,
  maxAgents: 2,
  maxConcurrentTurns: 1,
  maxTurnsPerAgent: 4,
  turnReservation: 100,
});
store.db.function("pause_task_commit", () => {
  process.send?.({ phase: "inside-task-transaction", rootId: root.id });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  return 0;
});
store.db.exec(
  "CREATE TRIGGER pause_task BEFORE INSERT ON task_requests BEGIN SELECT pause_task_commit(); END",
);
store.tasks.create(null, root.id, {
  requestKey: "retry",
  subject: "task",
  description: "atomic task creation",
  writeScopes: ["src"],
});
