import { Coordinator } from "../../src/coordinator/coordinator.ts";
import type { WorkspacePolicy } from "../../src/workspace/broker.ts";
import { ControlledRuntime } from "./controlled-runtime.ts";

const stateDirectory = process.argv[2]!;
const runtimeHome = process.argv[3]!;
const workspace = JSON.parse(process.argv[4]!) as WorkspacePolicy;
const runtime = new ControlledRuntime();
const coordinator = new Coordinator(
  { stateDirectory, runtimeHome, workspace },
  runtime,
);
await coordinator.start();
coordinator.createRoot("Lead", "fault fixture", {
  tokenPolicy: "observe",
  tokens: 1000,
  maxDepth: 0,
  maxAgents: 1,
  maxConcurrentTurns: 1,
  maxTurnsPerAgent: 2,
  turnReservation: 100,
});
while (!runtime.starts.length || !coordinator.store.attempts()[0]?.turn_id)
  await new Promise((r) => setTimeout(r, 10));
const t = runtime.starts[0]!;
const command = `'${process.execPath}' -e 'require("node:fs").writeFileSync("async-pid",String(process.pid));setInterval(()=>{},1000)'`;
runtime.onRequest({
  id: 1,
  method: "item/tool/call",
  connectionGeneration: 1,
  params: {
    threadId: t.threadId,
    turnId: t.turnId,
    callId: "crash-command",
    tool: "terminal_start",
    arguments: { command },
  },
});
while (!runtime.responses.length) await new Promise((r) => setTimeout(r, 10));
if (!(runtime.responses[0] as { success: boolean }).success)
  throw new Error("background command was not accepted");
