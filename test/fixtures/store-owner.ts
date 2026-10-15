import { Store } from "../../src/storage/store.ts";
const path = process.argv[2];
if (!path) throw new Error("State path required");
const store = new Store(path);
const root = store.createRoot("root", "pending work", {
  tokens: 1000,
  maxDepth: 2,
  maxAgents: 3,
  maxConcurrentTurns: 2,
  maxTurnsPerAgent: 5,
  turnReservation: 100,
});
const binding = store.bind(root.id, "persisted-native-thread", "fixture");
const attempt = store.prepare(root.id, "unknown native work");
store.markStarting(attempt.id);
process.stdout.write(
  JSON.stringify({
    pid: process.pid,
    root: root.id,
    binding,
    attempt: attempt.id,
  }) + "\n",
);
setInterval(() => {}, 60000);
