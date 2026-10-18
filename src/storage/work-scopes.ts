import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { integer, requireCondition, text } from "../core/errors.ts";
import type { Agent } from "./store.ts";

export const workScopeSchema = `
  CREATE INDEX IF NOT EXISTS attempt_history_page ON turn_attempts(agent_id,created_at,id);
  CREATE INDEX IF NOT EXISTS agent_message_status ON messages(recipient_id,status);
  CREATE INDEX IF NOT EXISTS human_message_status ON operator_messages(recipient_id,status);
  CREATE TABLE IF NOT EXISTS work_epochs(agent_id TEXT PRIMARY KEY REFERENCES agents(id),generation INTEGER NOT NULL,initial_enabled INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS work_refs(kind TEXT NOT NULL,object_id TEXT NOT NULL,agent_id TEXT NOT NULL REFERENCES agents(id),generation INTEGER NOT NULL,PRIMARY KEY(kind,object_id,agent_id));
  CREATE TABLE IF NOT EXISTS scope_replacements(id TEXT PRIMARY KEY,target_id TEXT NOT NULL REFERENCES agents(id),request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(target_id,request_key));
  CREATE TABLE IF NOT EXISTS scope_members(replacement_id TEXT NOT NULL REFERENCES scope_replacements(id),agent_id TEXT NOT NULL REFERENCES agents(id),generation INTEGER NOT NULL,PRIMARY KEY(replacement_id,agent_id));
  CREATE TABLE IF NOT EXISTS scope_invalid_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),replacement_id TEXT NOT NULL REFERENCES scope_replacements(id));
`;

/** Preserve legacy work at generation zero; never reinterpret it as newly admitted work. */
export function backfillWorkScopes(db: DatabaseSync) {
  db.exec(`
    INSERT OR IGNORE INTO work_epochs SELECT id,0,1 FROM agents;
    INSERT OR IGNORE INTO work_refs SELECT 'attempt',id,agent_id,0 FROM turn_attempts;
    INSERT OR IGNORE INTO work_refs SELECT 'message',id,recipient_id,0 FROM messages;
    INSERT OR IGNORE INTO work_refs SELECT 'message',id,sender_id,0 FROM messages;
    INSERT OR IGNORE INTO work_refs SELECT 'message',id,recipient_id,0 FROM operator_messages;
    INSERT OR IGNORE INTO work_refs SELECT 'task',id,created_by,0 FROM tasks;
    INSERT OR IGNORE INTO work_refs SELECT 'command',call_id,agent_id,0 FROM workspace_commands;
  `);
}

interface Context {
  db: DatabaseSync;
  transact<T>(fn: () => T): T;
  agent(id: string): Agent;
  subtree(id: string): Agent[];
  event(agent: Agent, kind: string, body: unknown): void;
}

export class WorkScopes {
  private readonly ctx: Context;
  constructor(ctx: Context) {
    this.ctx = ctx;
  }
  private rows(sql: string, ...args: SQLInputValue[]) {
    return this.ctx.db.prepare(sql).all(...args);
  }
  private run(sql: string, ...args: SQLInputValue[]) {
    return this.ctx.db.prepare(sql).run(...args);
  }
  epoch(id: string) {
    this.ctx.agent(id);
    const row = this.ctx.db
      .prepare("SELECT * FROM work_epochs WHERE agent_id=?")
      .get(id)!;
    return {
      generation: Number(row.generation),
      initialEnabled: row.initial_enabled === 1,
    };
  }
  record(kind: string, objectId: string, agentId: string) {
    this.run(
      "INSERT OR IGNORE INTO work_refs VALUES(?,?,?,?)",
      kind,
      objectId,
      agentId,
      this.epoch(agentId).generation,
    );
  }
  assertCurrent(kind: string, objectId: string, agentId: string) {
    const ref = this.ctx.db
      .prepare(
        "SELECT generation FROM work_refs WHERE kind=? AND object_id=? AND agent_id=?",
      )
      .get(kind, objectId, agentId);
    requireCondition(
      ref && ref.generation === this.epoch(agentId).generation,
      "STATE_BLOCKED",
      "Work belongs to a withdrawn scope generation",
    );
  }
  blocked(agentId: string) {
    return (
      this.rows(
        "SELECT r.id FROM scope_replacements r JOIN scope_members m ON m.replacement_id=r.id WHERE m.agent_id=? AND r.state='draining'",
        agentId,
      ).length > 0
    );
  }
  progress(id: string) {
    const row = this.ctx.db
      .prepare("SELECT * FROM scope_replacements WHERE id=?")
      .get(id);
    requireCondition(row, "NOT_FOUND", "Scope replacement not found");
    const snapshots = this.rows(
      "SELECT agent_id,generation FROM scope_members WHERE replacement_id=?",
      id,
    );
    const members = snapshots.map((r) => String(r.agent_id));
    const attempts = snapshots.flatMap((m) =>
      this.rows(
        "SELECT t.id,t.agent_id,t.state,t.turn_id FROM turn_attempts t JOIN work_refs r ON r.kind='attempt' AND r.object_id=t.id AND r.agent_id=t.agent_id WHERE t.agent_id=? AND r.generation<? AND t.state IN ('prepared','starting','running','unknown')",
        String(m.agent_id),
        Number(m.generation),
      ),
    );
    const commands = snapshots.flatMap((m) =>
      this.rows(
        "SELECT c.agent_id,c.call_id,c.state FROM workspace_commands c JOIN work_refs r ON r.kind='command' AND r.object_id=c.call_id AND r.agent_id=c.agent_id WHERE c.agent_id=? AND r.generation<? AND c.state='accepted'",
        String(m.agent_id),
        Number(m.generation),
      ),
    );
    const blocks = members.flatMap((agentId) => [
      ...this.rows(
        "SELECT agent_id,reason FROM runtime_blocks WHERE agent_id=?",
        agentId,
      ),
      ...this.rows(
        "SELECT agent_id,message_id,state FROM operator_guidance WHERE agent_id=? AND state IN ('dispatching','unknown')",
        agentId,
      ),
    ]);
    return {
      receipt: JSON.parse(String(row.receipt)) as {
        id: string;
        target: string;
        generation: number;
        members: string[];
      },
      state: String(row.state),
      attempts,
      commands,
      blocks,
    };
  }
  summary(agentId: string) {
    const row = this.rows(
      "SELECT r.id FROM scope_replacements r JOIN scope_members m ON m.replacement_id=r.id WHERE m.agent_id=? ORDER BY r.rowid DESC LIMIT 1",
      agentId,
    )[0];
    return {
      contractVersion: 2,
      ...this.epoch(agentId),
      replacement: row ? this.progress(String(row.id)) : null,
    };
  }
  replace(targetId: string, key: string, expected: number, assignment: string) {
    text(key, "replacement request key", 128);
    text(assignment, "replacement assignment");
    integer(expected, "expected scope generation");
    const fp = createHash("sha256")
      .update(JSON.stringify({ expected, assignment }))
      .digest("hex");
    const id = this.ctx.transact(() => {
      const target = this.ctx.agent(targetId);
      const prior = this.ctx.db
        .prepare(
          "SELECT * FROM scope_replacements WHERE target_id=? AND request_key=?",
        )
        .get(targetId, key);
      if (prior) {
        requireCondition(
          prior.fingerprint === fp,
          "CONFLICT",
          "Replacement key changed content",
        );
        return String(prior.id);
      }
      requireCondition(
        this.epoch(targetId).generation === expected,
        "STALE_REVISION",
        "Scope generation changed",
      );
      const members = this.ctx.subtree(targetId);
      requireCondition(
        target.desired !== "terminated" &&
          members.every((a) => !this.blocked(a.id)),
        "STATE_BLOCKED",
        "Terminated target or draining subtree cannot be replaced",
      );
      const id = randomUUID();
      const receipt = {
        id,
        target: targetId,
        generation: expected + 1,
        members: members.map((a) => a.id),
      };
      this.run(
        "INSERT INTO scope_replacements VALUES(?,?,?,?,?,'draining',?)",
        id,
        targetId,
        key,
        fp,
        JSON.stringify(receipt),
        new Date().toISOString(),
      );
      for (const agent of members) {
        integer(this.epoch(agent.id).generation + 1, "next scope generation");
        this.run(
          "INSERT INTO scope_members VALUES(?,?,?)",
          id,
          agent.id,
          this.epoch(agent.id).generation + 1,
        );
        this.run(
          "UPDATE work_epochs SET generation=generation+1,initial_enabled=0 WHERE agent_id=?",
          agent.id,
        );
        this.run(
          "UPDATE agents SET task=? WHERE id=?",
          agent.id === targetId
            ? assignment
            : "Previous assignment withdrawn. Await an explicit new assignment.",
          agent.id,
        );
        for (const attempt of this.rows(
          "SELECT id,reserved FROM turn_attempts WHERE agent_id=? AND state='prepared'",
          agent.id,
        )) {
          this.run(
            "UPDATE turn_attempts SET state='cancelled',reserved=0,completed_at=? WHERE id=?",
            new Date().toISOString(),
            String(attempt.id),
          );
          this.run(
            "UPDATE agents SET reserved=reserved-? WHERE id=?",
            Number(attempt.reserved),
            agent.id,
          );
        }
        for (const table of ["messages", "operator_messages"]) {
          // Sent but unconsumed inputs remain auditable; they are not treated as successful work.
          this.run(
            `UPDATE ${table} SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'unknown' END WHERE recipient_id=? AND status IN ('queued','delivering','acknowledged')`,
            agent.id,
          );
          this.run(
            `UPDATE ${table} SET status='cancelled' WHERE recipient_id=? AND attempt_id IN (SELECT id FROM turn_attempts WHERE state='cancelled') AND status='unknown'`,
            agent.id,
          );
        }
        // An old sender's queued reports must not escape into an unaffected branch.
        this.run(
          "UPDATE messages SET status='cancelled' WHERE sender_id=? AND status='queued'",
          agent.id,
        );
        for (const task of this.rows(
          "SELECT id FROM tasks WHERE status IN ('pending','in_progress') AND (owner_id=? OR (owner_id IS NULL AND created_by=?))",
          agent.id,
          agent.id,
        )) {
          this.run(
            "INSERT OR IGNORE INTO scope_invalid_tasks VALUES(?,?)",
            String(task.id),
            id,
          );
          this.run(
            "UPDATE tasks SET status='deleted',revision=revision+1,updated_at=? WHERE id=?",
            new Date().toISOString(),
            String(task.id),
          );
        }
        this.ctx.event(agent, "scope.withdrawn", {
          replacementId: id,
          generation: this.epoch(agent.id).generation,
        });
      }
      const messageId = randomUUID();
      this.run(
        "INSERT INTO operator_messages(id,recipient_id,input_key,body,created_at) VALUES(?,?,?,?,?)",
        messageId,
        targetId,
        `scope:${id}`,
        assignment,
        new Date().toISOString(),
      );
      this.record("message", messageId, targetId);
      // A new human objective renews autonomy, never cumulative task budgets.
      this.run(
        "UPDATE tree_interaction SET epoch_ms=?,warned=0,paused=0,stall_marker=NULL,error_marker=NULL WHERE tree_id=?",
        Date.now(),
        target.tree_id,
      );
      this.ctx.event(target, "scope.replacement.accepted", {
        ...receipt,
        messageId,
      });
      return id;
    });
    return this.progress(id);
  }
  advance() {
    for (const row of this.rows(
      "SELECT id FROM scope_replacements WHERE state='draining'",
    )) {
      this.ctx.transact(() => {
        const p = this.progress(String(row.id));
        if (p.attempts.length || p.commands.length || p.blocks.length) return;
        this.run(
          "UPDATE scope_replacements SET state='ready' WHERE id=?",
          p.receipt.id,
        );
        this.ctx.event(
          this.ctx.agent(p.receipt.target),
          "scope.replacement.ready",
          p.receipt,
        );
      });
    }
  }
}
