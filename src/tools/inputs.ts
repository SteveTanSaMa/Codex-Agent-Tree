import { requireCondition, integer, text } from "../core/errors.ts";
import type { DynamicTool } from "../runtime/codex/adapter.ts";

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
  const o = object(value, ["requestKey", "name", "role", "task", "tokens"]);
  requireCondition(
    typeof o.tokens === "number",
    "INVALID_INPUT",
    "Child token allocation required",
  );
  return {
    requestKey: text(o.requestKey, "requestKey", 128),
    name: text(o.name, "name", 96),
    role: text(o.role, "role", 1024),
    task: text(o.task, "task"),
    tokens: integer(o.tokens, "tokens", 1),
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
    "agent_spawn",
    "Create an authorized child with its own persistent identity and independent Codex Thread. Reuse requestKey for the same logical request. Budget is transferred from your own allocation. Accepted creation may still be initializing.",
    {
      requestKey: string,
      name: string,
      role: string,
      task: string,
      tokens: { type: "integer", minimum: 1 },
    },
    ["requestKey", "name", "role", "task", "tokens"],
  ),
  tool(
    "agent_send",
    "Persist a message to an Agent in your tree. Reuse requestKey for the same logical report. The host supplies your sender identity. Queued is not processed.",
    { requestKey: string, target: string, message: string },
    ["requestKey", "target", "message"],
  ),
  tool(
    "agent_ack",
    "Acknowledge message IDs delivered in your current Turn after handling their content. Processing becomes final only when this Turn completes successfully.",
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
