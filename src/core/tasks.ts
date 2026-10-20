import { integer, requireCondition, text } from "./errors.ts";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction =
  | "claim"
  | "release"
  | "edit"
  | "set_dependencies"
  | "complete"
  | "reopen"
  | "assign"
  | "delete";
export interface Task {
  id: string;
  treeId: string;
  createdBy: string;
  ownerId: string | null;
  revision: number;
  status: TaskStatus;
  subject: string;
  description: string;
  result: string | null;
  blockedBy: string[];
  writeScopes: string[];
  createdAt: string;
  updatedAt: string;
  ready: boolean;
  writeScopeWarnings: string[];
  withdrawnBy?: string;
  archivedAt?: string;
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_INPUT",
    "Task input must be an object",
  );
  const o = value as Record<string, unknown>;
  requireCondition(
    Object.keys(o).every((k) => allowed.includes(k)),
    "INVALID_INPUT",
    "Unknown task argument or caller identity field",
  );
  return o;
}
function strings(
  value: unknown,
  name: string,
  max: number,
  width: number,
): string[] {
  requireCondition(
    Array.isArray(value) && value.length <= max,
    "INVALID_INPUT",
    `Invalid ${name}`,
  );
  const result = value.map((v) => text(v, name, width));
  requireCondition(
    new Set(result).size === result.length,
    "INVALID_INPUT",
    `Duplicate ${name}`,
  );
  return result;
}
function scopes(value: unknown): string[] {
  return [
    ...new Set(
      strings(value, "writeScopes", 16, 256).map((scope) => {
        const path = scope
          .replaceAll("\\", "/")
          .replace(/^\.\//, "")
          .replace(/\/+$/, "");
        requireCondition(
          !path.startsWith("/") &&
            !/^[a-z]:/i.test(path) &&
            path.split("/").every((s) => s && s !== "." && s !== ".."),
          "INVALID_INPUT",
          "Write scopes must be relative path prefixes, without traversal",
        );
        return path;
      }),
    ),
  ];
}
export function createTaskInput(value: unknown) {
  const o = fields(value, [
    "requestKey",
    "subject",
    "description",
    "blockedBy",
    "writeScopes",
  ]);
  return {
    requestKey: text(o.requestKey, "requestKey", 128),
    subject: text(o.subject, "task subject", 200),
    description: text(o.description, "task description", 8000),
    blockedBy: strings(o.blockedBy ?? [], "blockedBy", 32, 256),
    writeScopes: scopes(o.writeScopes ?? []),
  };
}
export function updateTaskInput(value: unknown) {
  const o = fields(value, [
    "taskId",
    "requestKey",
    "expectedRevision",
    "action",
    "subject",
    "description",
    "blockedBy",
    "writeScopes",
    "ownerId",
    "result",
  ]);
  const action = text(o.action, "task action", 32) as TaskAction;
  const extra: Record<TaskAction, string[]> = {
    claim: [],
    release: [],
    edit: ["subject", "description", "writeScopes"],
    set_dependencies: ["blockedBy"],
    complete: ["result"],
    reopen: [],
    assign: ["ownerId"],
    delete: [],
  };
  requireCondition(
    Object.hasOwn(extra, action),
    "INVALID_INPUT",
    "Unknown task action",
  );
  requireCondition(
    Object.keys(o).every((k) =>
      [
        "taskId",
        "requestKey",
        "expectedRevision",
        "action",
        ...extra[action],
      ].includes(k),
    ),
    "INVALID_INPUT",
    "Arguments do not belong to this task action",
  );
  const common = {
    taskId: text(o.taskId, "task ID", 256),
    requestKey: text(o.requestKey, "requestKey", 128),
    expectedRevision: integer(
      o.expectedRevision as number,
      "expectedRevision",
      1,
    ),
    action,
  };
  if (action === "edit") {
    requireCondition(
      o.subject !== undefined ||
        o.description !== undefined ||
        o.writeScopes !== undefined,
      "INVALID_INPUT",
      "Task edit requires changed fields",
    );
    return {
      ...common,
      ...(o.subject === undefined
        ? {}
        : { subject: text(o.subject, "task subject", 200) }),
      ...(o.description === undefined
        ? {}
        : { description: text(o.description, "task description", 8000) }),
      ...(o.writeScopes === undefined
        ? {}
        : { writeScopes: scopes(o.writeScopes) }),
    };
  }
  if (action === "set_dependencies")
    return { ...common, blockedBy: strings(o.blockedBy, "blockedBy", 32, 256) };
  if (action === "assign")
    return {
      ...common,
      ownerId: o.ownerId === null ? null : text(o.ownerId, "owner ID", 256),
    };
  if (action === "complete")
    return { ...common, result: text(o.result, "task result", 8000) };
  return common;
}
export function getTaskInput(value: unknown): string {
  return text(fields(value, ["taskId"]).taskId, "task ID", 256);
}
export function taskSummary(task: Task) {
  const { description, result, ...summary } = task;
  return {
    ...summary,
    descriptionPreview: description.slice(0, 320),
    resultPreview: result?.slice(0, 1000) ?? null,
  };
}
export function validateTaskGraph(tasks: Task[]): void {
  const withdrawn = new Set(
    tasks.filter((t) => t.withdrawnBy !== undefined).map((t) => t.id),
  );
  const live = new Map(
    tasks.filter((t) => t.status !== "deleted").map((t) => [t.id, t]),
  );
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of live.values()) {
    requireCondition(
      task.blockedBy.every((id) => live.has(id) || withdrawn.has(id)),
      "INVALID_INPUT",
      "Task dependency is missing, deleted or outside the tree",
    );
    requireCondition(
      new Set(task.blockedBy).size === task.blockedBy.length,
      "INVALID_INPUT",
      "Duplicate task dependency",
    );
  }
  for (const task of live.values()) {
    const blockers = task.blockedBy.filter((id) => live.has(id));
    indegree.set(task.id, blockers.length);
    for (const dep of blockers) {
      const children = dependents.get(dep) ?? [];
      children.push(task.id);
      dependents.set(dep, children);
    }
  }
  const queue = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  // Kahn traversal retains missing/duplicate/cycle checks in O(V+E), including deep historical chains.
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!;
    visited++;
    for (const child of dependents.get(id) ?? []) {
      const degree = indegree.get(child)! - 1;
      indegree.set(child, degree);
      if (degree === 0) queue.push(child);
    }
  }
  requireCondition(
    visited === live.size,
    "CONFLICT",
    "Task dependencies contain a cycle",
  );
}
