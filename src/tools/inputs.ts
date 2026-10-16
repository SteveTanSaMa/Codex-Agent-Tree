import { requireCondition, integer, text } from "../core/errors.ts";
import type { DynamicTool } from "../runtime/codex/adapter.ts";
export {
  createTaskInput,
  updateTaskInput,
  getTaskInput,
} from "../core/tasks.ts";

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_INPUT",
    "Tool arguments must be an object",
  );
  const result = value as Record<string, unknown>;
  requireCondition(
    Object.keys(result).every((key) => allowed.includes(key)),
    "INVALID_INPUT",
    "Unknown argument or caller identity field",
  );
  return result;
}
export function spawnInput(value: unknown) {
  const o = object(value, [
    "requestKey",
    "name",
    "role",
    "task",
    "tokens",
    "repositoryId",
    "repositoryIds",
    "worktree",
  ]);
  requireCondition(
    o.worktree === undefined ||
      o.worktree === "isolated" ||
      o.worktree === "inherit",
    "INVALID_INPUT",
    "Invalid worktree mode",
  );
  requireCondition(
    o.repositoryIds === undefined ||
      (Array.isArray(o.repositoryIds) &&
        o.repositoryIds.length > 0 &&
        o.repositoryIds.length <= 16),
    "INVALID_INPUT",
    "Invalid repository grant",
  );
  return {
    ...(o.repositoryId === undefined
      ? {}
      : { repositoryId: text(o.repositoryId, "repositoryId", 64) }),
    ...(o.repositoryIds === undefined
      ? {}
      : {
          repositoryIds: (o.repositoryIds as unknown[]).map((id) =>
            text(id, "repository ID", 64),
          ),
        }),
    ...(o.worktree === undefined
      ? {}
      : { worktree: o.worktree as "isolated" | "inherit" }),
    requestKey: text(o.requestKey, "requestKey", 128),
    name: text(o.name, "name", 96),
    role: text(o.role, "role", 1024),
    task: text(o.task, "task"),
    ...(o.tokens === undefined
      ? {}
      : { tokens: integer(o.tokens as number, "tokens", 1) }),
  };
}
export function sendInput(value: unknown) {
  const o = object(value, ["requestKey", "target", "message"]);
  return {
    requestKey: text(o.requestKey, "requestKey", 128),
    target: text(o.target, "target", 256),
    message: text(o.message, "message"),
  };
}
export function ackInput(value: unknown): string[] {
  const o = object(value, ["messageIds"]);
  requireCondition(
    Array.isArray(o.messageIds) &&
      o.messageIds.length > 0 &&
      o.messageIds.length <= 100,
    "INVALID_INPUT",
    "Invalid receipt list",
  );
  return o.messageIds.map((id) => text(id, "message ID", 256));
}
export function statusInput(value: unknown): string | undefined {
  const o = object(value, ["target"]);
  return o.target === undefined ? undefined : text(o.target, "target", 256);
}
export function listInput(value: unknown): void {
  object(value, []);
}
export function controlInput(value: unknown): {
  target: string;
  action: "pause" | "resume" | "cancel" | "terminate";
  scope: "agent" | "subtree";
} {
  const o = object(value, ["target", "action", "scope"]);
  const action = o.action;
  const scope = o.scope ?? "subtree";
  requireCondition(
    action === "pause" ||
      action === "resume" ||
      action === "cancel" ||
      action === "terminate",
    "INVALID_INPUT",
    "Invalid lifecycle action",
  );
  requireCondition(
    scope === "agent" || scope === "subtree",
    "INVALID_INPUT",
    "Invalid control scope",
  );
  return { target: text(o.target, "target", 256), action, scope };
}
const string = { type: "string" };
function tool(
  name: string,
  description: string,
  properties: object,
  required: string[],
): DynamicTool {
  return {
    type: "function",
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
export const agentTools: DynamicTool[] = [
  tool(
    "agent_task_create",
    "Create an unowned persistent task in your tree. Use a stable requestKey for retries. Dependencies must complete before claim; ready never dispatches an Agent automatically.",
    {
      requestKey: string,
      subject: string,
      description: string,
      blockedBy: { type: "array", items: string, maxItems: 32 },
      writeScopes: { type: "array", items: string, maxItems: 16 },
    },
    ["requestKey", "subject", "description"],
  ),
  tool(
    "agent_task_get",
    "Read a task and its full result, owner, revision and dependencies in your tree, including deleted tombstones.",
    { taskId: string },
    ["taskId"],
  ),
  tool(
    "agent_task_list",
    "Read compact task summaries in your tree. Use agent_task_get for full input and result. Processed messages and idle Agents do not imply completed tasks.",
    {},
    [],
  ),
  tool(
    "agent_task_update",
    "Explicitly claim, release, edit, change dependencies, complete with a result, reopen, assign or delete a task. Supply the current expectedRevision and a stable requestKey; on a lost reply retry identical input/key. Assign/mutate owned work only within your management authority. No action wakes an Agent or bypasses budgets and human fences.",
    {
      taskId: string,
      requestKey: string,
      expectedRevision: { type: "integer", minimum: 1 },
      action: {
        type: "string",
        enum: [
          "claim",
          "release",
          "edit",
          "set_dependencies",
          "complete",
          "reopen",
          "assign",
          "delete",
        ],
      },
      subject: string,
      description: string,
      blockedBy: { type: "array", items: string, maxItems: 32 },
      writeScopes: { type: "array", items: string, maxItems: 16 },
      ownerId: { type: ["string", "null"] },
      result: string,
    },
    ["taskId", "requestKey", "expectedRevision", "action"],
  ),
  tool(
    "agent_spawn",
    "Create an authorized child with its own persistent identity and independent Codex Thread. Reuse requestKey for the same logical request. New teams have no per-Agent token allocation. The tokens field is only for legacy enforce compatibility and is ignored in observe mode. Structural and lifetime limits always apply. Accepted creation may still be initializing. Coding: repositoryId selects primary, repositoryIds delegates a subset (default only primary); second-level worktree is isolated, deeper default inherit or explicit isolated. Isolated starts at the registered base, not parent edits.",
    {
      requestKey: string,
      name: string,
      role: string,
      task: string,
      tokens: { type: "integer", minimum: 1 },
      repositoryId: string,
      repositoryIds: {
        type: "array",
        items: string,
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
      },
      worktree: { type: "string", enum: ["isolated", "inherit"] },
    },
    ["requestKey", "name", "role", "task"],
  ),
  tool(
    "agent_send",
    "Persist a message to an Agent in your tree. Reuse requestKey for the same logical report. The host supplies your sender identity. Queued is not processed.",
    { requestKey: string, target: string, message: string },
    ["requestKey", "target", "message"],
  ),
  tool(
    "agent_ack",
    "Acknowledge message IDs delivered in your current Turn after handling their content. The receipt becomes processed only when this Turn completes successfully. This confirms message consumption, not completion of delegated tasks or descendants.",
    {
      messageIds: { type: "array", items: string, minItems: 1, maxItems: 100 },
    },
    ["messageIds"],
  ),
  tool(
    "agent_list",
    "List the Agents in your tree with stable IDs, parents, Threads, attempts and message states.",
    {},
    [],
  ),
  tool(
    "agent_status",
    "Read your status or another Agent in your tree.",
    { target: string },
    [],
  ),
  tool(
    "agent_control",
    "Control yourself or descendants. Pause drains current Turns; cancel and terminate request interruption. Default scope is subtree. Termination is permanent. Model resume cannot clear a human pause.",
    {
      target: string,
      action: {
        type: "string",
        enum: ["pause", "resume", "cancel", "terminate"],
      },
      scope: { type: "string", enum: ["agent", "subtree"] },
    },
    ["target", "action"],
  ),
];
