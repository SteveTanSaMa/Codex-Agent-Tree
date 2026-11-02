import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { workspacePolicy } from "../../src/workspace/broker.ts";

const [stateDirectory, runtimeHome, repository, executable, envKey, service] =
  process.argv.slice(2);
if (!stateDirectory || !runtimeHome || !repository || !executable || !envKey)
  throw new Error("Missing native crash fixture configuration");
const c = new Coordinator({
  stateDirectory,
  runtimeHome,
  executable,
  credential: { envKey, ...(service ? { keychainService: service } : {}) },
  workspace: workspacePolicy(repository, {}),
});
await c.start();
const root = c.createRoot(
  "Lead",
  "Use terminal_start exactly once with this exact shell command: printf x >> crash-effects; echo $$ > crash-pid; exec /bin/sleep 120. After receiving the tool response, end this Turn immediately. Do not query status, run other commands, use other tools, send messages, or start another Agent.",
  {
    tokenPolicy: "observe",
    tokens: 100000,
    maxDepth: 0,
    maxAgents: 1,
    maxConcurrentTurns: 1,
    maxTurnsPerAgent: 3,
    maxTotalTurns: 3,
    turnReservation: 1000,
  },
  "native-crash-root",
);
const end = Date.now() + 90000;
while (Date.now() < end) {
  const attempts = c.store.attempts(root.id);
  const commands = c.store.db
    .prepare("SELECT call_id,state FROM workspace_commands WHERE agent_id=?")
    .all(root.id);
  if (
    attempts.length === 1 &&
    attempts[0]!.state === "completed" &&
    commands.length === 1 &&
    commands[0]!.state === "accepted"
  ) {
    writeFileSync(
      join(stateDirectory, "crash-ready.json"),
      JSON.stringify({
        rootId: root.id,
        binding: c.store.binding(root.id),
        attempt: attempts[0],
        commandId: commands[0]!.call_id,
      }),
      { mode: 0o600 },
    );
    // Parent kills this process while its accepted sandbox command is running.
    await new Promise(() => {});
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await c.stop();
throw new Error("Native model did not reach the crash-ready state");
