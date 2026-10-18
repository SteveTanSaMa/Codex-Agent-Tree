import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { requireCondition } from "../core/errors.ts";
import {
  createTaskInput,
  updateTaskInput,
  taskSummary,
  validateTaskGraph,
  type Task,
} from "../core/tasks.ts";
import type { Actor, Agent } from "./store.ts";

interface TaskContext {
  db: DatabaseSync;
  transact<T>(operation: () => T): T;
  agent(id: string): Agent;
  authenticate(actor: Actor): Agent;
  subtree(id: string): Agent[];
  event(agent: Agent, kind: string, body: unknown): void;
}
type Row = Record<string, SQLInputValue>;
export class TaskBoard {
  private readonly context: TaskContext;
  constructor(context: TaskContext) {
    this.context = context;
  }
  private caller(actor: Actor | null, target: string, write = false) {
    const agent = this.context.agent(target);
    const caller = actor ? this.context.authenticate(actor) : agent;
    requireCondition(
      caller.tree_id === agent.tree_id,
      "FORBIDDEN",
      "Task access outside caller tree",
    );
    if (write && actor)
      requireCondition(
        !["cancelled", "terminated"].includes(caller.desired),
        "STATE_BLOCKED",
        "Agent cannot mutate tasks after cancellation or termination",
      );
    return {
      caller,
      treeId: agent.tree_id,
      actorKey: actor ? `agent:${caller.id}` : "human",
    };
  }
  private rows(treeId: string): Task[] {
    const db = this.context.db;
    const rows = db
      .prepare(
        "SELECT t.*,i.replacement_id AS withdrawn_by FROM tasks t LEFT JOIN scope_invalid_tasks i ON i.task_id=t.id WHERE t.tree_id=? ORDER BY t.created_at,t.id",
      )
      .all(treeId) as Row[];
    const deps = db
      .prepare(
        "SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.tree_id=? ORDER BY d.depends_on",
      )
      .all(treeId) as Row[];
    const scopes = db
      .prepare(
        "SELECT s.* FROM task_scopes s JOIN tasks t ON t.id=s.task_id WHERE t.tree_id=? ORDER BY s.scope",
      )
      .all(treeId) as Row[];
    const grouped = (values: Row[], field: string) => {
      const result = new Map<string, string[]>();
      for (const row of values) {
        const id = String(row.task_id);
        const group = result.get(id) ?? [];
        group.push(String(row[field]));
        result.set(id, group);
      }
      return result;
    };
    const dependencies = grouped(deps, "depends_on");
    const writeScopes = grouped(scopes, "scope");
    const tasks = rows.map((r): Task => ({
      id: String(r.id),
      treeId: String(r.tree_id),
      createdBy: String(r.created_by),
      ownerId: r.owner_id === null ? null : String(r.owner_id),
      revision: Number(r.revision),
      status: r.status as Task["status"],
      subject: String(r.subject),
      description: String(r.description),
      result: r.result === null ? null : String(r.result),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      blockedBy: dependencies.get(String(r.id)) ?? [],
      writeScopes: writeScopes.get(String(r.id)) ?? [],
      ready: false,
      writeScopeWarnings: [],
      ...(r.withdrawn_by === null || r.withdrawn_by === undefined
        ? {}
        : { withdrawnBy: String(r.withdrawn_by) }),
    }));
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const positions = new Map(tasks.map((task, index) => [task.id, index]));
    // Prefixes are path components, so src/a conflicts with src/a/x but not src/ab.
    const exact = new Map<string, Set<string>>();
    const descendants = new Map<string, Set<string>>();
    const add = (index: Map<string, Set<string>>, path: string, id: string) => {
      const owners = index.get(path) ?? new Set<string>();
      owners.add(id);
      index.set(path, owners);
    };
    const prefixes = (scope: string) => {
      const result: string[] = [];
      let prefix = "";
      for (const part of scope.split("/")) {
        prefix = prefix ? prefix + "/" + part : part;
        result.push(prefix);
      }
      return result;
    };
    for (const task of tasks)
      if (task.status === "in_progress") {
        for (const scope of task.writeScopes) {
          add(exact, scope, task.id);
          for (const prefix of prefixes(scope))
            add(descendants, prefix, task.id);
        }
      }
    for (const t of tasks) {
      t.ready =
        t.status === "pending" &&
        t.blockedBy.every((id) => byId.get(id)?.status === "completed");
      const conflicts = new Set<string>();
      for (const scope of t.writeScopes) {
        for (const prefix of prefixes(scope))
          for (const id of exact.get(prefix) ?? []) conflicts.add(id);
        for (const id of descendants.get(scope) ?? []) conflicts.add(id);
      }
      conflicts.delete(t.id);
      t.writeScopeWarnings = [...conflicts]
        .sort((a, b) => positions.get(a)! - positions.get(b)!)
        .map((id) => `Write scopes overlap with ${id}; advisory only`);
    }
    return tasks;
  }
  get(actor: Actor | null, target: string, id: string): Task {
    const { treeId } = this.caller(actor, target);
    const task = this.rows(treeId).find((t) => t.id === id);
    requireCondition(task, "NOT_FOUND", "Task not found in caller tree");
    return task;
  }
  list(actor: Actor | null, target: string) {
    return this.rows(this.caller(actor, target).treeId)
      .filter((t) => t.status !== "deleted")
      .map(taskSummary);
  }
  private previous(
    treeId: string,
    actorKey: string,
    key: string,
    input: unknown,
  ): Task | undefined {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const old = this.context.db
      .prepare(
        "SELECT * FROM task_requests WHERE tree_id=? AND actor_key=? AND request_key=?",
      )
      .get(treeId, actorKey, key) as Row | undefined;
    if (!old) return;
    requireCondition(
      old.fingerprint === fingerprint,
      "CONFLICT",
      "Task request key changed content",
    );
    return JSON.parse(String(old.response_json)) as Task;
  }
  private save(
    treeId: string,
    actorKey: string,
    key: string,
    input: unknown,
    task: Task,
  ) {
    this.context.db
      .prepare("INSERT INTO task_requests VALUES(?,?,?,?,?)")
      .run(
        treeId,
        actorKey,
        key,
        createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        JSON.stringify(task),
      );
  }
  private relatedRows(task: Task) {
    const db = this.context.db;
    db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(task.id);
    db.prepare("DELETE FROM task_scopes WHERE task_id=?").run(task.id);
    for (const dep of task.blockedBy)
      db.prepare("INSERT INTO task_dependencies VALUES(?,?)").run(task.id, dep);
    for (const scope of task.writeScopes)
      db.prepare("INSERT INTO task_scopes VALUES(?,?)").run(task.id, scope);
  }
  create(actor: Actor | null, target: string, value: unknown): Task {
    const input = createTaskInput(value);
    return this.context.transact(() => {
      const { caller, treeId, actorKey } = this.caller(actor, target, true);
      const prior = this.previous(treeId, actorKey, input.requestKey, {
        kind: "create",
        input,
      });
      if (prior) return prior;
      const all = this.rows(treeId);
      requireCondition(
        all.filter((t) => t.status !== "deleted").length < 256,
        "STATE_BLOCKED",
        "Tree task limit 256 reached",
      );
      const time = new Date().toISOString();
      const task: Task = {
        id: randomUUID(),
        treeId,
        createdBy: caller.id,
        ownerId: null,
        revision: 1,
        status: "pending",
        subject: input.subject,
        description: input.description,
        result: null,
        blockedBy: input.blockedBy,
        writeScopes: input.writeScopes,
        createdAt: time,
        updatedAt: time,
        ready: false,
        writeScopeWarnings: [],
      };
      validateTaskGraph([...all, task]);
      this.context.db
        .prepare(
          "INSERT INTO tasks(id,tree_id,created_by,owner_id,revision,status,subject,description,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          task.id,
          treeId,
          caller.id,
          null,
          1,
          task.status,
          task.subject,
          task.description,
          null,
          time,
          time,
        );
      this.relatedRows(task);
      this.context.db
        .prepare("INSERT INTO work_refs VALUES('task',?,?,?)")
        .run(
          task.id,
          caller.id,
          Number(
            this.context.db
              .prepare("SELECT generation FROM work_epochs WHERE agent_id=?")
              .get(caller.id)!.generation,
          ),
        );
      const result = this.get(actor, target, task.id);
      this.save(
        treeId,
        actorKey,
        input.requestKey,
        { kind: "create", input },
        result,
      );
      this.context.event(caller, "task.created", {
        task: result,
        actor: actorKey,
      });
      return result;
    });
  }
  update(actor: Actor | null, target: string, value: unknown): Task {
    const input = updateTaskInput(value);
    return this.context.transact(() => {
      const { caller, treeId, actorKey } = this.caller(actor, target, true);
      const prior = this.previous(treeId, actorKey, input.requestKey, {
        kind: "update",
        input,
      });
      if (prior) return prior;
      const all = this.rows(treeId);
      const task = all.find((t) => t.id === input.taskId);
      requireCondition(task, "NOT_FOUND", "Task not found in caller tree");
      requireCondition(
        !this.context.db
          .prepare("SELECT task_id FROM scope_invalid_tasks WHERE task_id=?")
          .get(task.id),
        "STATE_BLOCKED",
        "Task belongs to a withdrawn scope; create a new task",
      );
      requireCondition(
        task.revision === input.expectedRevision,
        "STALE_REVISION",
        `Task revision is ${task.revision}; expected ${input.expectedRevision}`,
      );
      requireCondition(
        task.status !== "deleted",
        "STATE_BLOCKED",
        "Task is deleted",
      );
      const managed = new Set(this.context.subtree(caller.id).map((a) => a.id));
      if (input.action !== "claim" && actor)
        requireCondition(
          managed.has(task.ownerId ?? task.createdBy),
          "FORBIDDEN",
          "Task modification requires its owner or a management ancestor",
        );
      const next = {
        ...task,
        revision: task.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const ready = task.blockedBy.every(
        (id) => all.find((t) => t.id === id)?.status === "completed",
      );
      switch (input.action) {
        case "claim":
          requireCondition(
            task.status === "pending" && task.ownerId === null && ready,
            "STATE_BLOCKED",
            "Task is owned, started, or blocked",
          );
          next.status = "in_progress";
          next.ownerId = caller.id;
          break;
        case "release":
          requireCondition(
            task.status === "in_progress",
            "STATE_BLOCKED",
            "Only in-progress tasks can be released",
          );
          next.status = "pending";
          next.ownerId = null;
          break;
        case "assign": {
          requireCondition(
            task.status === "pending" || task.status === "in_progress",
            "STATE_BLOCKED",
            "Only unfinished tasks can be assigned",
          );
          const owner = (input as { ownerId: string | null }).ownerId;
          if (owner !== null) {
            const assignee = this.context.agent(owner);
            requireCondition(
              assignee.tree_id === treeId && (!actor || managed.has(owner)),
              "FORBIDDEN",
              "Task assignment is limited to the caller subtree",
            );
            requireCondition(
              ready && !["cancelled", "terminated"].includes(assignee.desired),
              "STATE_BLOCKED",
              "Task or assignee is unavailable",
            );
          }
          next.ownerId = owner;
          next.status = owner === null ? "pending" : "in_progress";
          break;
        }
        case "complete":
          requireCondition(
            task.status === "in_progress" && ready,
            "STATE_BLOCKED",
            "Only an in-progress task with completed blockers can complete",
          );
          next.status = "completed";
          next.result = (input as { result: string }).result;
          break;
        case "reopen":
          requireCondition(
            task.status === "completed",
            "STATE_BLOCKED",
            "Only completed tasks can reopen",
          );
          requireCondition(
            !all.some(
              (t) =>
                t.blockedBy.includes(task.id) &&
                ["in_progress", "completed"].includes(t.status),
            ),
            "STATE_BLOCKED",
            "Release or reopen started dependents first",
          );
          next.status = "pending";
          next.ownerId = null;
          next.result = null;
          break;
        case "edit": {
          const edit = input as {
            subject?: string;
            description?: string;
            writeScopes?: string[];
          };
          if (edit.subject !== undefined) next.subject = edit.subject;
          if (edit.description !== undefined)
            next.description = edit.description;
          if (edit.writeScopes !== undefined)
            next.writeScopes = edit.writeScopes;
          break;
        }
        case "set_dependencies":
          requireCondition(
            task.status === "pending" || task.status === "in_progress",
            "STATE_BLOCKED",
            "Reopen a completed task before changing dependencies",
          );
          next.blockedBy = (input as { blockedBy: string[] }).blockedBy;
          break;
        case "delete":
          next.status = "deleted";
          break;
      }
      validateTaskGraph(all.map((t) => (t.id === task.id ? next : t)));
      this.context.db
        .prepare(
          "UPDATE tasks SET owner_id=?,revision=?,status=?,subject=?,description=?,result=?,updated_at=? WHERE id=? AND revision=?",
        )
        .run(
          next.ownerId,
          next.revision,
          next.status,
          next.subject,
          next.description,
          next.result,
          next.updatedAt,
          task.id,
          task.revision,
        );
      this.relatedRows(next);
      const result = this.get(actor, target, task.id);
      this.save(
        treeId,
        actorKey,
        input.requestKey,
        { kind: "update", input },
        result,
      );
      this.context.event(caller, "task.updated", {
        action: input.action,
        actor: actorKey,
        task: result,
      });
      return result;
    });
  }
}
