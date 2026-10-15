import {
  WorkspaceBroker,
  type WorkspacePolicy,
} from "../../src/workspace/broker.ts";
import type { Agent } from "../../src/storage/store.ts";
const policy = JSON.parse(process.argv[2]!) as WorkspacePolicy;
const agent = { id: "parent-death-fixture", depth: 0 } as Agent;
const broker = new WorkspaceBroker(process.argv[3]!, policy, () => agent);
await broker.call(agent, "run_test", { name: "linger" });
