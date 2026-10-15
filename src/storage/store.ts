import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { requireCondition, text, integer } from "../core/errors.ts";
import { TaskBoard } from "./task-board.ts";

type Row = Record<string, unknown>;
export type DesiredState = "active" | "paused" | "cancelled" | "terminated";
export interface Agent {
  id: string;
  tree_id: string;
  parent_id: string | null;
  name: string;
  role: string;
  task: string;
  depth: number;
  desired: DesiredState;
  capacity: number;
  spent: number;
  reserved: number;
  turns: number;
  last_error: string | null;
}
export interface Binding {
  agent_id: string;
  thread_id: string;
  runtime_domain: string;
  generation: number;
  status: string;
}
export interface Actor {
  agentId: string;
  threadId: string;
  bindingGeneration: number;
  turnId: string;
}
export interface TreeLimits {
  tokenPolicy?: "observe" | "enforce";
  maxTotalTurns?: number;
  tokens: number;
  maxDepth: number;
  maxAgents: number;
  maxConcurrentTurns: number;
  maxTurnsPerAgent: number;
  turnReservation: number;
}
export interface Message {
  id: string;
  sender_id: string | null;
  recipient_id: string;
  body: string;
  status: string;
  attempt_id: string | null;
  created_at: string;
  processed_at: string | null;
  origin: "agent" | "human";
}
export interface Attempt {
  id: string;
  agent_id: string;
  binding_generation: number;
  thread_id: string;
  turn_id: string | null;
  state: string;
  input: string;
  trace_id: string;
  parent_turn_id: string | null;
  reserved: number;
  observed: number | null;
  result: string | null;
  created_at: string;
  completed_at: string | null;
  owner_generation: number;
  trigger_id: string | null;
}
const activeAttempts = "('prepared','starting','running','unknown')";
const now = () => new Date().toISOString();
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function processIdentity(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw error; // EPERM is not evidence of a dead owner.
  }
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
      }).trim() || "unobservable"
    );
  } catch {
    return "unobservable";
  }
}

/** Business state only. Never opens or edits Codex's history database. */
export class Store {
  readonly db: DatabaseSync;
  readonly ownerId = randomUUID();
  readonly generation: number;
  readonly tasks: TaskBoard;
  private commitWaiters = new Set<() => void>();
  private closed = false;
  private runtimeGeneration = 0;
  private drainingReceipts = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
      );
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
        INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
        CREATE TABLE IF NOT EXISTS owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT, pid INTEGER, identity TEXT, generation INTEGER NOT NULL);
        INSERT OR IGNORE INTO owner VALUES(1,NULL,NULL,NULL,0);
        CREATE TABLE IF NOT EXISTS trees(id TEXT PRIMARY KEY, limits_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id), parent_id TEXT REFERENCES agents(id), name TEXT NOT NULL, role TEXT NOT NULL, task TEXT NOT NULL, depth INTEGER NOT NULL, desired TEXT NOT NULL DEFAULT 'active', capacity INTEGER NOT NULL CHECK(capacity>=0), spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0), turns INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime_connections(generation INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, native_pid INTEGER, protocol_version TEXT NOT NULL, owner_generation INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempt_runtime_connections(attempt_id TEXT NOT NULL REFERENCES turn_attempts(id), server_generation INTEGER NOT NULL, PRIMARY KEY(attempt_id,server_generation));
        CREATE TABLE IF NOT EXISTS runtime_blocks(agent_id TEXT PRIMARY KEY REFERENCES agents(id), reason TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime_block_turns(agent_id TEXT NOT NULL REFERENCES runtime_blocks(agent_id) ON DELETE CASCADE, turn_id TEXT NOT NULL, PRIMARY KEY(agent_id,turn_id));
        CREATE TABLE IF NOT EXISTS session_observations(agent_id TEXT PRIMARY KEY REFERENCES agents(id), state_json TEXT NOT NULL, observed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS spawn_sources(agent_id TEXT PRIMARY KEY REFERENCES agents(id), spawned_by TEXT NOT NULL, source_turn_id TEXT NOT NULL, trace_id TEXT NOT NULL, spawn_reason TEXT NOT NULL, expected_output TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS message_causes(message_id TEXT PRIMARY KEY, source_turn_id TEXT NOT NULL, trace_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS root_requests(request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id));
        CREATE TABLE IF NOT EXISTS agent_session_bindings(agent_id TEXT NOT NULL REFERENCES agents(id), thread_id TEXT NOT NULL, runtime_domain TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, retired_at TEXT, PRIMARY KEY(agent_id,generation));
        CREATE UNIQUE INDEX IF NOT EXISTS active_agent_binding ON agent_session_bindings(agent_id) WHERE status='active';
        CREATE UNIQUE INDEX IF NOT EXISTS active_thread_binding ON agent_session_bindings(thread_id) WHERE status='active';
        CREATE TABLE IF NOT EXISTS usage_cursors(thread_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY(thread_id,binding_generation));
        CREATE TABLE IF NOT EXISTS control_fences(agent_id TEXT NOT NULL REFERENCES agents(id), source TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(agent_id,source));
        CREATE TABLE IF NOT EXISTS operations(actor_id TEXT NOT NULL REFERENCES agents(id), operation_key TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, result_id TEXT NOT NULL, PRIMARY KEY(actor_id,operation_key));
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES agents(id), recipient_id TEXT NOT NULL REFERENCES agents(id), body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempt_id TEXT, created_at TEXT NOT NULL, processed_at TEXT);
        CREATE TABLE IF NOT EXISTS operator_messages(id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES agents(id), input_key TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempt_id TEXT, created_at TEXT NOT NULL, processed_at TEXT, UNIQUE(recipient_id,input_key));
        CREATE TABLE IF NOT EXISTS turn_attempts(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), thread_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, owner_generation INTEGER NOT NULL, turn_id TEXT, state TEXT NOT NULL, input TEXT NOT NULL, trace_id TEXT NOT NULL, parent_turn_id TEXT, trigger_id TEXT, reserved INTEGER NOT NULL, observed INTEGER, result TEXT, created_at TEXT NOT NULL, completed_at TEXT);
        CREATE TABLE IF NOT EXISTS attempt_accounting(attempt_id TEXT PRIMARY KEY REFERENCES turn_attempts(id), charged INTEGER NOT NULL DEFAULT 0, finalized INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'native');
        CREATE TABLE IF NOT EXISTS usage_evidence(attempt_id TEXT PRIMARY KEY REFERENCES turn_attempts(id), native_total INTEGER, attested INTEGER, direct_floor INTEGER NOT NULL DEFAULT 0);
        CREATE UNIQUE INDEX IF NOT EXISTS active_agent_attempt ON turn_attempts(agent_id) WHERE state IN ${activeAttempts};
        CREATE UNIQUE INDEX IF NOT EXISTS native_turn ON turn_attempts(thread_id,turn_id) WHERE turn_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tree_id TEXT, agent_id TEXT, attempt_id TEXT, kind TEXT NOT NULL, owner_generation INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id), created_by TEXT NOT NULL REFERENCES agents(id), owner_id TEXT REFERENCES agents(id), revision INTEGER NOT NULL CHECK(revision>=1), status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','deleted')), subject TEXT NOT NULL, description TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS task_dependencies(task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(task_id,depends_on));
        CREATE TABLE IF NOT EXISTS task_scopes(task_id TEXT NOT NULL REFERENCES tasks(id), scope TEXT NOT NULL, PRIMARY KEY(task_id,scope));
        CREATE TABLE IF NOT EXISTS task_requests(tree_id TEXT NOT NULL REFERENCES trees(id), actor_key TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(tree_id,actor_key,request_key));
      `);
      requireCondition(
        [1, 2, 3, 4, 5, 6, 7, 8].includes(
          Number(this.one("SELECT version FROM schema_version")?.version),
        ),
        "CONFLICT",
        "Unsupported business schema version",
      );
      if (
        this.all("PRAGMA table_info(runtime_connections)").some(
          (c) => c.name === "native_pid" && c.notnull === 1,
        )
      ) {
        this.db
          .exec(`ALTER TABLE runtime_connections RENAME TO runtime_connections_v1;
          CREATE TABLE runtime_connections(generation INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, native_pid INTEGER, protocol_version TEXT NOT NULL, owner_generation INTEGER NOT NULL, created_at TEXT NOT NULL);
          INSERT INTO runtime_connections SELECT * FROM runtime_connections_v1;
          DROP TABLE runtime_connections_v1;`);
      }
      // Backfill once. Legacy interrupted usage may be partial; restore liability.
      for (const row of this.all(
        "SELECT t.* FROM turn_attempts t LEFT JOIN attempt_accounting c ON c.attempt_id=t.id WHERE c.attempt_id IS NULL",
      )) {
        const terminal = ["completed", "failed", "interrupted"].includes(
          String(row.state),
        );
        const finalized =
          row.state === "completed" &&
          row.observed !== null &&
          row.reserved === 0;
        this.run(
          "INSERT INTO attempt_accounting VALUES(?,?,?,?)",
          String(row.id),
          terminal ? Number(row.observed ?? 0) : 0,
          finalized ? 1 : 0,
          "legacy-backfill",
        );
        if (
          ["failed", "interrupted"].includes(String(row.state)) &&
          row.reserved === 0
        ) {
          const agent = this.agent(String(row.agent_id));
          const liability = this.limits(agent.tree_id).turnReservation;
          this.run(
            "UPDATE turn_attempts SET reserved=? WHERE id=?",
            liability,
            String(row.id),
          );
          this.run(
            "UPDATE agents SET reserved=reserved+? WHERE id=?",
            liability,
            agent.id,
          );
        }
      }
      const upgradeUsage =
        Number(this.one("SELECT version FROM schema_version")?.version) < 7;
      if (upgradeUsage) {
        for (const a of this.all(
          "SELECT t.*,c.charged,c.source FROM turn_attempts t JOIN attempt_accounting c ON c.attempt_id=t.id",
        )) {
          const samples = this.all(
            "SELECT body FROM events WHERE attempt_id=? AND kind='usage.observed' ORDER BY sequence",
            String(a.id),
          );
          const totals = samples
            .map((e) => JSON.parse(String(e.body)).cumulativeTokens)
            .filter((v) => Number.isSafeInteger(v) && v >= 0) as number[];
          const receipts = this.all(
            "SELECT body FROM events WHERE attempt_id=? AND kind='budget.settled' ORDER BY sequence",
            String(a.id),
          ).map((e) => Number(JSON.parse(String(e.body)).tokens));
          const attested = receipts.length
            ? Math.max(...receipts)
            : a.source === "human-attested"
              ? Number(a.charged)
              : null;
          this.run(
            "INSERT OR REPLACE INTO usage_evidence VALUES(?,?,?,?)",
            String(a.id),
            totals.length ? Math.max(...totals) : null,
            attested,
            totals.length
              ? 0
              : Number(
                  a.observed ??
                    (a.source === "human-attested" ? 0 : a.charged) ??
                    0,
                ),
          );
        }
      }
      // One durable sequence across both message sources. Legacy ties have no
      // recoverable insertion order; preserve their previous deterministic order.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS usage_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL REFERENCES turn_attempts(id), tokens INTEGER NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', UNIQUE(attempt_id,tokens));
        CREATE TABLE IF NOT EXISTS workspace_commands(agent_id TEXT NOT NULL REFERENCES agents(id), call_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(agent_id,call_id));
        CREATE TABLE IF NOT EXISTS message_order(sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE);
        INSERT OR IGNORE INTO message_order(message_id)
          SELECT id FROM (SELECT id,created_at FROM messages UNION ALL SELECT id,created_at FROM operator_messages) ORDER BY created_at,id;
        CREATE TRIGGER IF NOT EXISTS message_enqueue_order AFTER INSERT ON messages BEGIN INSERT INTO message_order(message_id) VALUES(NEW.id); END;
        CREATE TRIGGER IF NOT EXISTS operator_enqueue_order AFTER INSERT ON operator_messages BEGIN INSERT INTO message_order(message_id) VALUES(NEW.id); END;
      `);
      this.run("UPDATE schema_version SET version=8");
      try {
        const previous = this.one("SELECT * FROM owner WHERE singleton=1")!;
        if (previous.id !== null) {
          const identity = processIdentity(Number(previous.pid));
          requireCondition(
            identity === null ||
              (identity !== "unobservable" && identity !== previous.identity),
            "OWNER_ACTIVE",
            "A live or unobservable coordinator owns this database",
          );
        }
        this.generation = Number(previous.generation) + 1;
        this.run(
          "UPDATE owner SET id=?,pid=?,identity=?,generation=? WHERE singleton=1",
          this.ownerId,
          process.pid,
          processIdentity(process.pid),
          this.generation,
        );
        if (upgradeUsage) {
          for (const b of this.all(
            "SELECT DISTINCT thread_id,binding_generation FROM turn_attempts",
          ))
            this.reconcileUsage(
              String(b.thread_id),
              Number(b.binding_generation),
            );
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.tasks = new TaskBoard({
      db: this.db,
      transact: (operation) => this.transaction(operation),
      agent: (id) => this.agent(id),
      authenticate: (actor) => this.actor(actor),
      subtree: (id) => this.subtree(id),
      event: (agent, kind, body) => this.event(agent, kind, body),
    });
    this.applyPendingReceipts();
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  private transaction<T>(fn: () => T): T {
    requireCondition(!this.closed, "STALE_OWNER", "Store is closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.one(
        "SELECT id,generation FROM owner WHERE singleton=1",
      );
      requireCondition(
        owner?.id === this.ownerId && owner.generation === this.generation,
        "STALE_OWNER",
        "Coordinator generation no longer owns state",
      );
      const before = this.eventCursor();
      const result = fn();
      const changed = this.eventCursor() !== before;
      this.db.exec("COMMIT");
      if (changed) for (const resolve of [...this.commitWaiters]) resolve();
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private event(
    agent: Agent,
    kind: string,
    body: unknown,
    attempt: string | null = null,
  ) {
    this.run(
      "INSERT INTO events(id,tree_id,agent_id,attempt_id,kind,owner_generation,body,created_at) VALUES(?,?,?,?,?,?,?,?)",
      randomUUID(),
      agent.tree_id,
      agent.id,
      attempt,
      kind,
      this.generation,
      JSON.stringify(body),
      now(),
    );
  }
  agent(id: string): Agent {
    const row = this.one("SELECT * FROM agents WHERE id=?", id);
    requireCondition(row, "NOT_FOUND", "Agent not found");
    return row as unknown as Agent;
  }
  agents(treeId?: string): Agent[] {
    return this.all(
      `SELECT * FROM agents ${treeId ? "WHERE tree_id=?" : ""} ORDER BY created_at,id`,
      ...(treeId ? [treeId] : []),
    ) as unknown as Agent[];
  }
  limits(treeId: string): TreeLimits {
    const t = this.one("SELECT limits_json FROM trees WHERE id=?", treeId);
    requireCondition(t, "NOT_FOUND", "Tree not found");
    const limits = JSON.parse(String(t.limits_json)) as TreeLimits;
    return {
      ...limits,
      tokenPolicy: limits.tokenPolicy ?? "enforce",
      maxTotalTurns:
        limits.maxTotalTurns ?? limits.maxAgents * limits.maxTurnsPerAgent,
    };
  }
  binding(id: string): Binding | undefined {
    return this.one(
      "SELECT * FROM agent_session_bindings WHERE agent_id=? AND status='active'",
      id,
    ) as unknown as Binding | undefined;
  }
  private insertAgent(
    parent: Agent | null,
    name: string,
    role: string,
    task: string,
    capacity: number,
    treeId: string,
  ): Agent {
    const id = randomUUID();
    this.run(
      "INSERT INTO agents(id,tree_id,parent_id,name,role,task,depth,capacity,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      treeId,
      parent?.id ?? null,
      text(name, "name", 96),
      text(role, "role", 1024),
      text(task, "task"),
      (parent?.depth ?? -1) + 1,
      capacity,
      now(),
    );
    const agent = this.agent(id);
    this.event(agent, "agent.created", {
      parent: parent?.id ?? null,
      expectedOutput: task,
    });
    return agent;
  }
  createRoot(
    name: string,
    task: string,
    limits: TreeLimits,
    requestKey: string = randomUUID(),
  ): Agent {
    const policy = limits.tokenPolicy ?? "observe";
    requireCondition(
      policy === "observe" || policy === "enforce",
      "INVALID_INPUT",
      "Invalid token policy",
    );
    for (const key of [
      "tokens",
      "maxDepth",
      "maxAgents",
      "maxConcurrentTurns",
      "maxTurnsPerAgent",
      "turnReservation",
    ] as const)
      integer(limits[key], key, key === "maxDepth" ? 0 : 1);
    const maxTotalTurns = integer(
      limits.maxTotalTurns ?? 100,
      "maxTotalTurns",
      1,
    );
    requireCondition(
      policy === "observe" || limits.turnReservation <= limits.tokens,
      "INVALID_INPUT",
      "Turn reservation exceeds total budget",
    );
    return this.transaction(() => {
      text(requestKey, "root request key", 128);
      const hash = fingerprint({ name, task, limits });
      const previous = this.one(
        "SELECT * FROM root_requests WHERE request_key=?",
        requestKey,
      );
      if (previous) {
        requireCondition(
          previous.fingerprint === hash,
          "CONFLICT",
          "Root request key changed content",
        );
        return this.agent(String(previous.agent_id));
      }
      const treeId = randomUUID();
      this.run(
        "INSERT INTO trees VALUES(?,?,?)",
        treeId,
        JSON.stringify({ ...limits, tokenPolicy: policy, maxTotalTurns }),
        now(),
      );
      const root = this.insertAgent(
        null,
        name,
        "root",
        task,
        limits.tokens,
        treeId,
      );
      this.run(
        "INSERT INTO root_requests VALUES(?,?,?)",
        requestKey,
        hash,
        root.id,
      );
      return root;
    });
  }
  authenticate(
    threadId: string,
    turnId: string,
    bindingGeneration: number,
  ): Actor {
    const b = this.one(
      "SELECT * FROM agent_session_bindings WHERE thread_id=? AND generation=? AND status='active'",
      threadId,
      bindingGeneration,
    );
    requireCondition(b, "STALE_BINDING", "No active trusted binding");
    const a = this.one(
      "SELECT * FROM turn_attempts WHERE agent_id=? AND thread_id=? AND turn_id=? AND binding_generation=? AND state='running'",
      String(b.agent_id),
      threadId,
      turnId,
      bindingGeneration,
    );
    requireCondition(
      a,
      "FORBIDDEN",
      "Tool request does not belong to the active Turn",
    );
    return { agentId: String(b.agent_id), threadId, turnId, bindingGeneration };
  }
  beginWorkspaceCommand(
    actor: Actor,
    callId: string,
    input: unknown,
  ): { cached: boolean; result?: unknown } {
    text(callId, "native tool call ID", 256);
    return this.transaction(() => {
      const agent = this.actor(actor);
      this.dispatchable(agent);
      const fp = fingerprint({ turnId: actor.turnId, input });
      const prior = this.one(
        "SELECT * FROM workspace_commands WHERE agent_id=? AND call_id=?",
        agent.id,
        callId,
      );
      if (prior) {
        requireCondition(
          prior.fingerprint === fp,
          "CONFLICT",
          "Test call ID changed input",
        );
        requireCondition(
          prior.state === "completed",
          "STATE_BLOCKED",
          "Previous test command outcome is unknown or still running; inspect before submitting new work",
        );
        return {
          cached: true,
          result: JSON.parse(String(prior.result_json)) as unknown,
        };
      }
      this.run(
        "INSERT INTO workspace_commands VALUES(?,?,?,'accepted',NULL,?)",
        agent.id,
        callId,
        fp,
        now(),
      );
      this.event(agent, "workspace.command.accepted", {
        callId,
        turnId: actor.turnId,
      });
      return { cached: false };
    });
  }
  finishWorkspaceCommand(agentId: string, callId: string, result: unknown) {
    this.transaction(() => {
      this.run(
        "UPDATE workspace_commands SET state='completed',result_json=? WHERE agent_id=? AND call_id=? AND state='accepted'",
        JSON.stringify(result),
        agentId,
        callId,
      );
      this.event(this.agent(agentId), "workspace.command.completed", {
        callId,
      });
    });
  }
  workspaceCommandSummary(agentId: string) {
    return this.one(
      "SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN state='accepted' THEN 1 ELSE 0 END),0) AS unresolved FROM workspace_commands WHERE agent_id=?",
      agentId,
    );
  }
  pendingUsageReceipts(agentId: string) {
    return this.all(
      "SELECT r.attempt_id,r.tokens,r.reason FROM usage_receipts r JOIN turn_attempts t ON t.id=r.attempt_id WHERE t.agent_id=? AND r.state='pending' ORDER BY r.sequence LIMIT 100",
      agentId,
    );
  }
  workspaceCommands(agentId: string) {
    return this.all(
      "SELECT call_id,state,created_at,result_json FROM workspace_commands WHERE agent_id=? ORDER BY rowid DESC LIMIT 20",
      agentId,
    )
      .reverse()
      .map(({ result_json, ...row }) => {
        const result =
          result_json === null
            ? null
            : (JSON.parse(String(result_json)) as Record<string, unknown>);
        return {
          ...row,
          result: result
            ? {
                ...result,
                output: String(result.output ?? "").slice(0, 2000),
                outputPreview: true,
              }
            : null,
        };
      });
  }
  private actor(actor: Actor): Agent {
    const verified = this.authenticate(
      actor.threadId,
      actor.turnId,
      actor.bindingGeneration,
    );
    requireCondition(
      verified.agentId === actor.agentId,
      "FORBIDDEN",
      "Actor identity mismatch",
    );
    return this.agent(verified.agentId);
  }
  private dispatchable(agent: Agent): void {
    // Subtree controls materialize fences for every existing descendant in the same transaction.
    // A single-Agent control intentionally leaves existing children dispatchable.
    requireCondition(
      agent.desired === "active",
      "STATE_BLOCKED",
      "Agent is not active",
    );
    requireCondition(
      !this.runtimeBlock(agent.id),
      "STATE_BLOCKED",
      "Unreconciled native execution blocks dispatch",
    );
  }
  budgetStatus(treeId: string) {
    const totals = this.one(
      "SELECT SUM(spent) AS spent,SUM(reserved) AS reserved FROM agents WHERE tree_id=?",
      treeId,
    )!;
    const unknown = this.all(
      "SELECT t.id FROM turn_attempts t JOIN agents a ON a.id=t.agent_id WHERE a.tree_id=? AND t.state IN ('completed','failed','interrupted') AND t.reserved>0",
      treeId,
    ).map((a) => String(a.id));
    const tokens = this.limits(treeId).tokens;
    const observedTokens = Number(
      this.one(
        "SELECT COALESCE(SUM(MAX(COALESCE(t.observed,0),COALESCE(c.charged,0))),0) AS n FROM turn_attempts t JOIN agents a ON a.id=t.agent_id LEFT JOIN attempt_accounting c ON c.attempt_id=t.id WHERE a.tree_id=?",
        treeId,
      )?.n,
    );
    const spent = Number(totals.spent ?? 0);
    const reserved = Number(totals.reserved ?? 0);
    return {
      tokenPolicy: this.limits(treeId).tokenPolicy!,
      enforced: this.limits(treeId).tokenPolicy === "enforce",
      warningThresholdTokens: tokens,
      observedTokens,
      warningExceeded: observedTokens > tokens,
      tokens,
      spent,
      reserved,
      availableTokens: Math.max(0, tokens - spent - reserved),
      excessLiabilityTokens: Math.max(0, spent + reserved - tokens),
      unknownUsageAttempts: unknown,
    };
  }
  executionStatus(treeId: string) {
    const limits = this.limits(treeId);
    const usedTurns = Number(
      this.one(
        "SELECT COALESCE(SUM(turns),0) AS n FROM agents WHERE tree_id=?",
        treeId,
      )?.n,
    );
    return {
      maxTotalTurns: limits.maxTotalTurns!,
      usedTurns,
      remainingTurns: Math.max(0, limits.maxTotalTurns! - usedTurns),
      maxAgents: limits.maxAgents,
      createdAgents: this.agents(treeId).length,
      maxConcurrentTurns: limits.maxConcurrentTurns,
      maxDepth: limits.maxDepth,
      maxTurnsPerAgent: limits.maxTurnsPerAgent,
    };
  }
  private admitGlobal(agent: Agent, reservation: number) {
    const pool = this.budgetStatus(agent.tree_id);
    if (!pool.enforced) return;
    requireCondition(
      !pool.unknownUsageAttempts.length,
      "STATE_BLOCKED",
      "Unresolved usage blocks new consumption",
    );
    requireCondition(
      pool.spent + pool.reserved + reservation <= pool.tokens,
      "BUDGET_EXHAUSTED",
      "Global tree budget cannot admit new consumption",
    );
  }
  private operation(
    actor: Agent,
    key: string,
    kind: string,
    input: unknown,
  ): string | undefined {
    text(key, "operation key", 128);
    const previous = this.one(
      "SELECT * FROM operations WHERE actor_id=? AND operation_key=?",
      actor.id,
      key,
    );
    if (!previous) return undefined;
    requireCondition(
      previous.kind === kind && previous.fingerprint === fingerprint(input),
      "CONFLICT",
      "Operation key reused with different content",
    );
    return String(previous.result_id);
  }
  private saveOperation(
    actor: Agent,
    key: string,
    kind: string,
    input: unknown,
    resultId: string,
  ) {
    this.run(
      "INSERT INTO operations VALUES(?,?,?,?,?)",
      actor.id,
      key,
      kind,
      fingerprint(input),
      resultId,
    );
  }
  spawn(
    actor: Actor,
    key: string,
    input: { name: string; role: string; task: string; tokens?: number },
  ): Agent {
    if (input.tokens !== undefined) integer(input.tokens, "child tokens", 1);
    return this.transaction(() => {
      const parent = this.actor(actor);
      const prior = this.operation(parent, key, "spawn", input);
      if (prior) return this.agent(prior);
      this.dispatchable(parent);
      const limits = this.limits(parent.tree_id);
      this.admitGlobal(parent, limits.turnReservation);
      requireCondition(
        parent.depth < limits.maxDepth &&
          this.agents(parent.tree_id).length < limits.maxAgents,
        "STATE_BLOCKED",
        "Depth or lifetime Agent limit reached",
      );
      requireCondition(
        this.executionStatus(parent.tree_id).remainingTurns > 0,
        "STATE_BLOCKED",
        "Tree lifetime Turn limit reached",
      );
      const allocation = input.tokens ?? 0;
      if (limits.tokenPolicy === "enforce") {
        requireCondition(
          input.tokens !== undefined &&
            parent.capacity - parent.spent - parent.reserved >= allocation,
          "BUDGET_EXHAUSTED",
          "Parent cannot allocate child budget",
        );
        requireCondition(
          allocation >= limits.turnReservation,
          "BUDGET_EXHAUSTED",
          "Child budget cannot admit one Turn",
        );
        this.run(
          "UPDATE agents SET capacity=capacity-? WHERE id=?",
          allocation,
          parent.id,
        );
      }
      const child = this.insertAgent(
        parent,
        input.name,
        input.role,
        input.task,
        limits.tokenPolicy === "enforce" ? allocation : 0,
        parent.tree_id,
      );
      const source = this.one(
        "SELECT trace_id FROM turn_attempts WHERE thread_id=? AND turn_id=?",
        actor.threadId,
        actor.turnId,
      )!;
      this.run(
        "INSERT INTO spawn_sources VALUES(?,?,?,?,?,?)",
        child.id,
        parent.id,
        actor.turnId,
        String(source.trace_id),
        input.task,
        input.task,
      );
      this.saveOperation(parent, key, "spawn", input, child.id);
      this.event(child, "spawn.accepted", {
        spawnedBy: parent.id,
        parentTurnId: actor.turnId,
        operationKey: key,
        reason: input.task,
      });
      return child;
    });
  }
  bind(agentId: string, threadId: string, domain: string): Binding {
    text(threadId, "Thread", 256);
    text(domain, "domain", 128);
    return this.transaction(() => {
      const agent = this.agent(agentId);
      requireCondition(
        !this.runtimeBlock(agentId),
        "STATE_BLOCKED",
        "Unowned native execution must be reconciled before rebinding",
      );
      requireCondition(
        !this.one(
          "SELECT id FROM turn_attempts WHERE agent_id=? AND state IN ('starting','running','unknown')",
          agentId,
        ),
        "STATE_BLOCKED",
        "Cannot rebind live or uncertain execution",
      );
      const previous = this.one(
        "SELECT MAX(generation) AS generation FROM agent_session_bindings WHERE agent_id=?",
        agentId,
      );
      const generation = Number(previous?.generation ?? 0) + 1;
      this.run(
        "UPDATE agent_session_bindings SET status='retired',retired_at=? WHERE agent_id=? AND status='active'",
        now(),
        agentId,
      );
      this.run(
        "INSERT INTO agent_session_bindings(agent_id,thread_id,runtime_domain,generation,status,created_at) VALUES(?,?,?,?,'active',?)",
        agentId,
        threadId,
        domain,
        generation,
        now(),
      );
      this.run(
        "UPDATE turn_attempts SET thread_id=?,binding_generation=?,owner_generation=? WHERE agent_id=? AND state='prepared'",
        threadId,
        generation,
        this.generation,
        agentId,
      );
      this.event(agent, "session.bound", { threadId, domain, generation });
      return this.binding(agentId)!;
    });
  }
  retireUnstartedBinding(agentId: string) {
    this.transaction(() => {
      const agent = this.agent(agentId);
      requireCondition(
        !this.runtimeBlock(agentId),
        "STATE_BLOCKED",
        "Unowned native execution is quarantined",
      );
      requireCondition(
        this.attempts(agentId).every(
          (a) =>
            a.turn_id === null && ["prepared", "cancelled"].includes(a.state),
        ),
        "STATE_BLOCKED",
        "A dispatched Session cannot be retired as empty",
      );
      this.run(
        "UPDATE agent_session_bindings SET status='retired',retired_at=? WHERE agent_id=? AND status='active'",
        now(),
        agentId,
      );
      this.event(agent, "session.empty_retired", {
        reason:
          "No Turn was dispatched; native empty context cannot be resumed",
      });
    });
  }
  send(actor: Actor, key: string, target: string, body: string): string {
    text(body, "message");
    return this.transaction(() => {
      const sender = this.actor(actor);
      const input = { target, body };
      const prior = this.operation(sender, key, "send", input);
      if (prior) return prior;
      const recipient = this.agent(target);
      requireCondition(
        sender.tree_id === recipient.tree_id &&
          !["cancelled", "terminated"].includes(sender.desired) &&
          !["cancelled", "terminated"].includes(recipient.desired),
        "FORBIDDEN",
        "Message route not authorized",
      );
      const id = randomUUID();
      this.run(
        "INSERT INTO messages(id,sender_id,recipient_id,body,created_at) VALUES(?,?,?,?,?)",
        id,
        sender.id,
        target,
        body,
        now(),
      );
      const source = this.one(
        "SELECT trace_id FROM turn_attempts WHERE thread_id=? AND turn_id=?",
        actor.threadId,
        actor.turnId,
      )!;
      this.run(
        "INSERT INTO message_causes VALUES(?,?,?)",
        id,
        actor.turnId,
        String(source.trace_id),
      );
      this.saveOperation(sender, key, "send", input, id);
      this.event(sender, "message.queued", {
        messageId: id,
        target,
        parentTurnId: actor.turnId,
      });
      return id;
    });
  }
  messages(agentId: string): Message[] {
    this.agent(agentId);
    return [
      ...this.all(
        "SELECT m.*,o.sequence AS enqueue_sequence, 'agent' AS origin FROM messages m JOIN message_order o ON o.message_id=m.id WHERE recipient_id=?",
        agentId,
      ),
      ...this.all(
        "SELECT m.*,o.sequence AS enqueue_sequence, NULL AS sender_id, 'human' AS origin FROM operator_messages m JOIN message_order o ON o.message_id=m.id WHERE recipient_id=?",
        agentId,
      ),
    ].sort(
      (a, b) => Number(a.enqueue_sequence) - Number(b.enqueue_sequence),
    ) as unknown as Message[];
  }
  rejectQueuedMessage(agentId: string, messageId: string, reason: string) {
    text(reason, "delivery failure reason", 2048);
    this.transaction(() => {
      const agent = this.agent(agentId);
      const message = this.messages(agentId).find((m) => m.id === messageId);
      requireCondition(
        message?.status === "queued",
        "CONFLICT",
        "Only a queued message can be rejected before delivery",
      );
      const table =
        message.origin === "human" ? "operator_messages" : "messages";
      this.run(`UPDATE ${table} SET status='rejected' WHERE id=?`, messageId);
      this.event(agent, "message.delivery_rejected", {
        messageId,
        origin: message.origin,
        reason,
      });
    });
  }
  operatorSend(target: string, key: string, body: string): string {
    text(key, "input key", 128);
    text(body, "operator message");
    return this.transaction(() => {
      const agent = this.agent(target);
      requireCondition(
        !["cancelled", "terminated"].includes(agent.desired),
        "STATE_BLOCKED",
        "Agent does not accept new work",
      );
      const prior = this.one(
        "SELECT * FROM operator_messages WHERE recipient_id=? AND input_key=?",
        target,
        key,
      );
      if (prior) {
        requireCondition(
          prior.body === body,
          "CONFLICT",
          "Operator input key changed content",
        );
        return String(prior.id);
      }
      const id = randomUUID();
      this.run(
        "INSERT INTO operator_messages(id,recipient_id,input_key,body,created_at) VALUES(?,?,?,?,?)",
        id,
        target,
        key,
        body,
        now(),
      );
      this.event(agent, "operator.message", { messageId: id, inputKey: key });
      return id;
    });
  }
  prepare(
    agentId: string,
    input: string,
    parentTurnId: string | null = null,
    triggerId: string | null = null,
    deliveryIds?: string[],
  ): Attempt {
    text(input, "Turn input", 60000);
    return this.transaction(() => {
      const agent = this.agent(agentId);
      this.dispatchable(agent);
      requireCondition(
        !this.one(
          `SELECT id FROM turn_attempts WHERE agent_id=? AND state IN ${activeAttempts}`,
          agentId,
        ),
        "STATE_BLOCKED",
        "Agent has live or uncertain execution",
      );
      const pending = this.messages(agentId).filter(
        (m) => m.status === "queued",
      );
      const deliveries = [...new Set(deliveryIds ?? pending.map((m) => m.id))];
      requireCondition(
        deliveries.length <= 100 &&
          deliveries.every((id) => pending.some((m) => m.id === id)),
        "CONFLICT",
        "Invalid message batch",
      );
      const b = this.binding(agentId);
      requireCondition(b, "STATE_BLOCKED", "Agent has no active binding");
      const limits = this.limits(agent.tree_id);
      this.admitGlobal(agent, limits.turnReservation);
      requireCondition(
        agent.turns < limits.maxTurnsPerAgent &&
          this.executionStatus(agent.tree_id).remainingTurns > 0,
        "STATE_BLOCKED",
        "Agent or tree lifetime Turn limit reached",
      );
      const active = Number(
        this.one(
          `SELECT COUNT(*) AS n FROM turn_attempts t JOIN agents a ON a.id=t.agent_id WHERE a.tree_id=? AND t.state IN ${activeAttempts}`,
          agent.tree_id,
        )?.n,
      );
      requireCondition(
        active < limits.maxConcurrentTurns,
        "STATE_BLOCKED",
        "Concurrent Turn limit reached",
      );
      requireCondition(
        limits.tokenPolicy === "observe" ||
          agent.capacity - agent.spent - agent.reserved >=
            limits.turnReservation,
        "BUDGET_EXHAUSTED",
        "Insufficient available Turn budget",
      );
      const cause = triggerId
        ? this.one("SELECT * FROM message_causes WHERE message_id=?", triggerId)
        : agent.turns === 0
          ? this.one("SELECT * FROM spawn_sources WHERE agent_id=?", agentId)
          : undefined;
      const id = randomUUID();
      const trace = cause ? String(cause.trace_id) : randomUUID();
      const causalParent =
        parentTurnId ?? (cause ? String(cause.source_turn_id) : null);
      this.run(
        "INSERT INTO turn_attempts(id,agent_id,thread_id,binding_generation,owner_generation,state,input,trace_id,parent_turn_id,trigger_id,reserved,created_at) VALUES(?,?,?,?,?,'prepared',?,?,?,?,?,?)",
        id,
        agentId,
        b.thread_id,
        b.generation,
        this.generation,
        input,
        trace,
        causalParent,
        triggerId,
        limits.turnReservation,
        now(),
      );
      this.run("INSERT INTO attempt_accounting(attempt_id) VALUES(?)", id);
      this.run(
        "UPDATE agents SET reserved=reserved+?,turns=turns+1 WHERE id=?",
        limits.turnReservation,
        agentId,
      );
      this.run(
        "INSERT INTO attempt_runtime_connections VALUES(?,?)",
        id,
        this.runtimeGeneration,
      );
      for (const messageId of deliveries)
        for (const table of ["messages", "operator_messages"])
          this.run(
            `UPDATE ${table} SET status='delivering',attempt_id=? WHERE id=? AND recipient_id=? AND status='queued'`,
            id,
            messageId,
            agentId,
          );
      this.event(
        agent,
        "turn.prepared",
        {
          traceId: trace,
          correlationId: agent.tree_id,
          serverGeneration: this.runtimeGeneration,
          ownerGeneration: this.generation,
          inputSummary: input.slice(0, 160),
          parentTurnId: causalParent,
          triggerId,
          bindingGeneration: b.generation,
        },
        id,
      );
      return this.attempt(id);
    });
  }
  attempt(id: string): Attempt {
    const row = this.one("SELECT * FROM turn_attempts WHERE id=?", id);
    requireCondition(row, "NOT_FOUND", "Attempt not found");
    return row as unknown as Attempt;
  }
  attemptForTurn(threadId: string, turnId: string): Attempt | undefined {
    return this.one(
      "SELECT * FROM turn_attempts WHERE thread_id=? AND turn_id=?",
      threadId,
      turnId,
    ) as unknown as Attempt | undefined;
  }
  attempts(agentId?: string): Attempt[] {
    return this.all(
      `SELECT * FROM turn_attempts ${agentId ? "WHERE agent_id=?" : ""} ORDER BY created_at,id`,
      ...(agentId ? [agentId] : []),
    ) as unknown as Attempt[];
  }
  private currentAttempt(id: string, generation: number): Attempt {
    const a = this.attempt(id);
    const binding = this.binding(a.agent_id);
    requireCondition(
      a.binding_generation === generation &&
        binding?.generation === generation &&
        binding.thread_id === a.thread_id,
      "STALE_BINDING",
      "Attempt binding was replaced",
    );
    return a;
  }
  markStarting(id: string) {
    this.transaction(() => {
      const a = this.attempt(id);
      requireCondition(
        a.state === "prepared",
        "CONFLICT",
        "Attempt is not prepared",
      );
      this.dispatchable(this.agent(a.agent_id));
      this.run("UPDATE turn_attempts SET state='starting' WHERE id=?", id);
    });
  }
  attachTurn(id: string, generation: number, turnId: string) {
    this.transaction(() => {
      const a = this.currentAttempt(id, generation);
      requireCondition(
        ["starting", "unknown"].includes(a.state),
        "CONFLICT",
        "Attempt is not awaiting a Turn",
      );
      text(turnId, "Turn ID", 256);
      requireCondition(
        a.turn_id === null || a.turn_id === turnId,
        "CONFLICT",
        "Cannot replace a known Turn during reconciliation",
      );
      this.run(
        "UPDATE turn_attempts SET state='running',turn_id=? WHERE id=?",
        turnId,
        id,
      );
      this.event(this.agent(a.agent_id), "turn.started", { turnId }, id);
    });
  }
  observeUsage(id: string, generation: number, tokens: number) {
    integer(tokens, "observed usage");
    this.transaction(() => {
      const a = this.currentAttempt(id, generation);
      requireCondition(
        ["starting", "running", "unknown"].includes(a.state),
        "CONFLICT",
        "Usage for terminal attempt requires explicit reconciliation",
      );
      this.run(
        "UPDATE turn_attempts SET observed=? WHERE id=?",
        Math.max(tokens, a.observed ?? 0),
        id,
      );
      this.run(
        "INSERT INTO usage_evidence(attempt_id,direct_floor) VALUES(?,?) ON CONFLICT(attempt_id) DO UPDATE SET direct_floor=MAX(direct_floor,excluded.direct_floor)",
        id,
        tokens,
      );
    });
  }
  acknowledge(actor: Actor, messageIds: string[]) {
    this.transaction(() => {
      this.actor(actor);
      const a = this.one(
        "SELECT id FROM turn_attempts WHERE thread_id=? AND turn_id=? AND state='running'",
        actor.threadId,
        actor.turnId,
      )!;
      for (const id of messageIds) {
        const nativeMessage = this.one("SELECT * FROM messages WHERE id=?", id);
        const table = nativeMessage ? "messages" : "operator_messages";
        const m =
          nativeMessage ??
          this.one("SELECT * FROM operator_messages WHERE id=?", id);
        requireCondition(
          m?.recipient_id === actor.agentId &&
            m.attempt_id === a.id &&
            ["delivering", "acknowledged"].includes(String(m.status)),
          "FORBIDDEN",
          "Message does not belong to this delivery",
        );
        this.run(`UPDATE ${table} SET status='acknowledged' WHERE id=?`, id);
      }
    });
  }
  finish(
    id: string,
    generation: number,
    state: "completed" | "failed" | "interrupted",
    result: string,
  ) {
    this.transaction(() => {
      const a = this.currentAttempt(id, generation);
      if (a.state === state) return;
      requireCondition(
        ["running", "unknown"].includes(a.state),
        "CONFLICT",
        "Attempt cannot finish from current state",
      );
      const known = state === "completed" && a.observed !== null;
      const usage = a.observed ?? 0;
      // Partial usage does not establish final cost for failed/interrupted work.
      this.run(
        "UPDATE attempt_accounting SET charged=?,finalized=? WHERE attempt_id=?",
        usage,
        known ? 1 : 0,
        id,
      );
      this.run(
        "UPDATE agents SET spent=spent+?,reserved=reserved-?,last_error=? WHERE id=?",
        usage,
        known ? a.reserved : 0,
        state === "completed" ? null : state,
        a.agent_id,
      );
      this.run(
        "UPDATE turn_attempts SET state=?,result=?,reserved=?,completed_at=? WHERE id=?",
        state,
        result.slice(0, 60000),
        known ? 0 : a.reserved,
        now(),
        id,
      );
      for (const table of ["messages", "operator_messages"])
        this.run(
          `UPDATE ${table} SET status=CASE WHEN status='acknowledged' AND ?='completed' THEN 'processed' ELSE 'unknown' END,processed_at=CASE WHEN status='acknowledged' AND ?='completed' THEN ? ELSE NULL END WHERE attempt_id=? AND status IN ('delivering','acknowledged')`,
          state,
          state,
          now(),
          id,
        );
      this.event(
        this.agent(a.agent_id),
        "turn.finished",
        {
          state,
          observedTokens: a.observed,
          retainedLiability: known ? 0 : a.reserved,
        },
        id,
      );
      this.releaseTerminated(a.agent_id);
    });
  }
  uncertain(id: string, reason: string) {
    this.transaction(() => {
      const a = this.attempt(id);
      requireCondition(
        ["starting", "running", "unknown"].includes(a.state),
        "CONFLICT",
        "Cannot mark terminal or unissued attempt uncertain",
      );
      this.run("UPDATE turn_attempts SET state='unknown' WHERE id=?", id);
      this.run(
        "UPDATE agents SET last_error=? WHERE id=?",
        reason.slice(0, 1024),
        a.agent_id,
      );
      this.event(this.agent(a.agent_id), "turn.unknown", { reason }, id);
    });
  }
  subtree(agentId: string): Agent[] {
    this.agent(agentId);
    return this.all(
      "WITH RECURSIVE descendants(id) AS (SELECT ? UNION ALL SELECT a.id FROM agents a JOIN descendants d ON a.parent_id=d.id) SELECT a.* FROM agents a JOIN descendants d ON a.id=d.id ORDER BY a.depth,a.id",
      agentId,
    ) as unknown as Agent[];
  }
  /** A null actor means the private human control channel, never model-supplied input. */
  control(
    actor: Actor | null,
    targetId: string,
    action: "pause" | "resume" | "cancel" | "terminate",
    scope: "agent" | "subtree" = "subtree",
  ): Attempt[] {
    return this.transaction(() => {
      const target = this.agent(targetId);
      const source = actor ? `model:${this.actor(actor).id}` : "human";
      if (actor)
        requireCondition(
          this.subtree(actor.agentId).some((a) => a.id === targetId),
          "FORBIDDEN",
          "Control is limited to the caller subtree",
        );
      const targets = scope === "subtree" ? this.subtree(targetId) : [target];
      for (const previous of targets) {
        requireCondition(
          previous.desired !== "terminated" || action === "terminate",
          "STATE_BLOCKED",
          "Termination is permanent",
        );
        if (action === "resume") {
          if (actor) {
            const clearable = new Set(
              this.subtree(actor.agentId).map((a) => `model:${a.id}`),
            );
            for (const fence of this.all(
              "SELECT source FROM control_fences WHERE agent_id=?",
              previous.id,
            ))
              if (clearable.has(String(fence.source)))
                this.run(
                  "DELETE FROM control_fences WHERE agent_id=? AND source=?",
                  previous.id,
                  String(fence.source),
                );
          } else
            this.run(
              "DELETE FROM control_fences WHERE agent_id=? AND action IN ('pause','cancel')",
              previous.id,
            );
        } else
          this.run(
            "INSERT INTO control_fences VALUES(?,?,?,?) ON CONFLICT(agent_id,source) DO UPDATE SET action=excluded.action,created_at=excluded.created_at",
            previous.id,
            source,
            action,
            now(),
          );
        const fences = this.all(
          "SELECT action FROM control_fences WHERE agent_id=?",
          previous.id,
        ).map((f) => f.action);
        const desired = fences.includes("terminate")
          ? "terminated"
          : fences.includes("cancel")
            ? "cancelled"
            : fences.includes("pause")
              ? "paused"
              : "active";
        this.run(
          "UPDATE agents SET desired=? WHERE id=?",
          desired,
          previous.id,
        );
        if (desired === "cancelled" || desired === "terminated") {
          for (const a of this.attempts(previous.id).filter(
            (a) => a.state === "prepared",
          )) {
            this.run(
              "UPDATE turn_attempts SET state='cancelled',reserved=0,completed_at=? WHERE id=?",
              now(),
              a.id,
            );
            this.run(
              "UPDATE agents SET reserved=reserved-? WHERE id=?",
              a.reserved,
              previous.id,
            );
            for (const table of ["messages", "operator_messages"])
              this.run(
                `UPDATE ${table} SET status='cancelled' WHERE attempt_id=? AND status IN ('delivering','acknowledged')`,
                a.id,
              );
          }
          for (const table of ["messages", "operator_messages"])
            this.run(
              `UPDATE ${table} SET status='cancelled' WHERE recipient_id=? AND status='queued'`,
              previous.id,
            );
        }
        this.event(previous, "agent.control", {
          source,
          action,
          desired,
          scope,
        });
      }
      for (const agent of [...targets].reverse())
        this.releaseTerminated(agent.id);
      // Drain is the pause default. Cancel/terminate require runtime interruption, not a fictitious terminal status.
      return action === "cancel" || action === "terminate"
        ? targets.flatMap((a) =>
            this.attempts(a.id).filter((t) =>
              ["starting", "running", "unknown"].includes(t.state),
            ),
          )
        : [];
    });
  }
  private releaseTerminated(agentId: string): void {
    const agent = this.agent(agentId);
    if (
      this.limits(agent.tree_id).tokenPolicy === "observe" ||
      agent.desired !== "terminated" ||
      !agent.parent_id ||
      agent.reserved > 0 ||
      this.attempts(agentId).some((a) =>
        ["prepared", "starting", "running", "unknown"].includes(a.state),
      )
    )
      return;
    const unused = Math.max(0, agent.capacity - agent.spent);
    if (!unused) return;
    this.run(
      "UPDATE agents SET capacity=capacity-? WHERE id=?",
      unused,
      agentId,
    );
    this.run(
      "UPDATE agents SET capacity=capacity+? WHERE id=?",
      unused,
      agent.parent_id,
    );
    this.event(agent, "budget.released", { unused, parent: agent.parent_id });
    this.releaseTerminated(agent.parent_id);
  }
  registerRuntime(
    domain: string,
    nativePid: number | null,
    protocolVersion: string,
  ): number {
    text(domain, "runtime domain", 128);
    if (nativePid !== null) integer(nativePid, "native PID", 1);
    text(protocolVersion, "protocol version", 128);
    const generation = this.transaction(() =>
      Number(
        this.run(
          "INSERT INTO runtime_connections(domain,native_pid,protocol_version,owner_generation,created_at) VALUES(?,?,?,?,?)",
          domain,
          nativePid,
          protocolVersion,
          this.generation,
          now(),
        ).lastInsertRowid,
      ),
    );
    this.runtimeGeneration = generation;
    return generation;
  }
  observeAttemptRuntime(id: string) {
    this.transaction(() => {
      const attempt = this.attempt(id);
      this.run(
        "INSERT OR IGNORE INTO attempt_runtime_connections VALUES(?,?)",
        id,
        this.runtimeGeneration,
      );
      this.event(
        this.agent(attempt.agent_id),
        "recovery.runtime_observed",
        {
          serverGeneration: this.runtimeGeneration,
          ownerGeneration: this.generation,
        },
        id,
      );
    });
  }
  runtimeConnections(): Row[] {
    return this.all("SELECT * FROM runtime_connections ORDER BY generation");
  }
  runtimeBlock(agentId: string): Row | undefined {
    return this.one("SELECT * FROM runtime_blocks WHERE agent_id=?", agentId);
  }
  blockRuntime(agentId: string, reason: string, turnIds: string[] = []) {
    this.transaction(() => {
      const agent = this.agent(agentId);
      this.run(
        "INSERT INTO runtime_blocks VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at",
        agentId,
        reason,
        now(),
      );
      for (const turnId of turnIds) {
        text(turnId, "quarantined Turn", 256);
        this.run(
          "INSERT OR IGNORE INTO runtime_block_turns VALUES(?,?)",
          agentId,
          turnId,
        );
      }
      this.event(agent, "runtime.quarantined", { reason, turnIds });
    });
  }
  clearRecoveredRuntimeBlock(agentId: string) {
    return this.transaction(() => {
      const block = this.runtimeBlock(agentId);
      if (
        !block ||
        ![
          "Unowned live native Turn observed during recovery",
          "An unowned native Turn started; inspect its history before continuing",
        ].includes(String(block.reason))
      )
        return false;
      const turns = this.all(
        "SELECT turn_id FROM runtime_block_turns WHERE agent_id=?",
        agentId,
      );
      const binding = this.binding(agentId);
      if (
        !turns.length ||
        !binding ||
        !turns.every((turn) =>
          this.one(
            "SELECT id FROM turn_attempts WHERE agent_id=? AND thread_id=? AND binding_generation=? AND turn_id=? AND state IN ('running','completed','failed','interrupted')",
            agentId,
            binding.thread_id,
            binding.generation,
            String(turn.turn_id),
          ),
        )
      )
        return false;
      this.run("DELETE FROM runtime_blocks WHERE agent_id=?", agentId);
      this.event(this.agent(agentId), "runtime.quarantine_reconciled", {
        source: "native-history",
        turnIds: turns.map((t) => t.turn_id),
        bindingGeneration: binding.generation,
      });
      return true;
    });
  }
  clearRuntimeBlock(agentId: string, reason: string) {
    text(reason, "review reason", 2048);
    this.transaction(() => {
      const agent = this.agent(agentId);
      this.run("DELETE FROM runtime_blocks WHERE agent_id=?", agentId);
      this.event(agent, "runtime.quarantine_reviewed", {
        source: "human",
        reason,
      });
    });
  }
  observeSession(agentId: string, state: unknown) {
    this.transaction(() => {
      const agent = this.agent(agentId);
      const json = JSON.stringify(state);
      const previous = this.one(
        "SELECT state_json FROM session_observations WHERE agent_id=?",
        agentId,
      );
      this.run(
        "INSERT INTO session_observations VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET state_json=excluded.state_json,observed_at=excluded.observed_at",
        agentId,
        json,
        now(),
      );
      if (previous?.state_json !== json)
        this.event(agent, "session.observed", { state });
    });
  }
  sessionObservation(agentId: string): Row | undefined {
    return this.one(
      "SELECT * FROM session_observations WHERE agent_id=?",
      agentId,
    );
  }
  note(
    agentId: string,
    kind: string,
    payload: unknown,
    attemptId: string | null = null,
  ) {
    this.transaction(() =>
      this.event(this.agent(agentId), kind, payload, attemptId),
    );
  }
  updateResult(id: string, generation: number, result: string) {
    this.transaction(() => {
      this.currentAttempt(id, generation);
      this.run(
        "UPDATE turn_attempts SET result=? WHERE id=?",
        result.slice(0, 60000),
        id,
      );
    });
  }
  /** Re-derive attribution from ordered prefix evidence, never from charged deltas.
   * A late receipt may move cost between Turns; it cannot change native facts.
   * No sample/receipt leaves final usage unknown and its reservation intact. */
  private reconcileUsage(threadId: string, generation: number) {
    let prefix = 0;
    for (const row of this.all(
      "SELECT t.*,c.charged,c.finalized,e.native_total,e.attested,e.direct_floor FROM turn_attempts t JOIN attempt_accounting c ON c.attempt_id=t.id LEFT JOIN usage_evidence e ON e.attempt_id=t.id WHERE t.thread_id=? AND t.binding_generation=? ORDER BY t.rowid",
      threadId,
      generation,
    )) {
      requireCondition(
        row.native_total === null ||
          row.native_total === undefined ||
          Number(row.native_total) >= prefix,
        "CONFLICT",
        "Native cumulative usage contradicts preceding Turn evidence; reconcile receipts before continuing",
      );
      const observed =
        row.native_total === null || row.native_total === undefined
          ? row.observed === null
            ? null
            : Number(row.direct_floor ?? row.observed)
          : Math.max(
              0,
              Number(row.native_total) - prefix,
              Number(row.direct_floor ?? 0),
            );
      const cost = Math.max(observed ?? 0, Number(row.attested ?? 0));
      prefix += cost;
      const terminal = ["completed", "failed", "interrupted"].includes(
        String(row.state),
      );
      const final =
        (row.attested !== null && row.attested !== undefined) ||
        (row.state === "completed" && observed !== null);
      const charged = terminal ? cost : Number(row.charged);
      const reserved =
        terminal && final ? 0 : Math.max(Number(row.reserved), cost);
      this.run(
        "UPDATE turn_attempts SET observed=?,reserved=? WHERE id=?",
        observed,
        reserved,
        String(row.id),
      );
      this.run(
        "UPDATE attempt_accounting SET charged=?,finalized=? WHERE attempt_id=?",
        charged,
        terminal && final ? 1 : 0,
        String(row.id),
      );
      this.run(
        "UPDATE agents SET spent=spent+?,reserved=reserved+? WHERE id=?",
        charged - Number(row.charged),
        reserved - Number(row.reserved),
        String(row.agent_id),
      );
      if (observed !== row.observed || charged !== row.charged)
        this.event(
          this.agent(String(row.agent_id)),
          "usage.attributed",
          {
            observed,
            charged,
            previousObserved: row.observed,
            previousCharged: row.charged,
            nativeTotal: row.native_total ?? null,
            attested: row.attested ?? null,
          },
          String(row.id),
        );
    }
    const owner = this.one(
      "SELECT agent_id FROM turn_attempts WHERE thread_id=? AND binding_generation=? LIMIT 1",
      threadId,
      generation,
    );
    if (owner) this.releaseTerminated(String(owner.agent_id));
  }
  observeNativeUsage(
    id: string,
    generation: number,
    cumulativeTokens: number,
    breakdown?: {
      total: Record<string, number | null>;
      last: Record<string, number | null>;
    },
  ) {
    integer(cumulativeTokens, "cumulative native usage");
    this.transaction(() => {
      const a = this.currentAttempt(id, generation);
      const agent = this.agent(a.agent_id);
      const previousPool = this.budgetStatus(agent.tree_id);
      const previous = Number(
        this.one(
          "SELECT native_total FROM usage_evidence WHERE attempt_id=?",
          id,
        )?.native_total ?? 0,
      );
      if (cumulativeTokens < previous) {
        this.event(
          agent,
          "usage.out_of_order",
          { previous, cumulativeTokens },
          id,
        );
        return;
      }
      this.run(
        "INSERT INTO usage_evidence(attempt_id,native_total) VALUES(?,?) ON CONFLICT(attempt_id) DO UPDATE SET native_total=excluded.native_total",
        id,
        cumulativeTokens,
      );
      // Preserve the event's raw Thread delta independently of per-Turn attribution.
      const nativePrevious = Number(
        this.one(
          "SELECT total FROM usage_cursors WHERE thread_id=? AND binding_generation=?",
          a.thread_id,
          generation,
        )?.total ?? 0,
      );
      // The cursor is native evidence only. Human receipts never move it.
      this.run(
        "INSERT INTO usage_cursors VALUES(?,?,?) ON CONFLICT(thread_id,binding_generation) DO UPDATE SET total=MAX(total,excluded.total)",
        a.thread_id,
        generation,
        cumulativeTokens,
      );
      this.reconcileUsage(a.thread_id, generation);
      this.event(
        agent,
        "usage.observed",
        {
          cumulativeTokens,
          delta: Math.max(0, cumulativeTokens - nativePrevious),
          observed: this.attempt(id).observed,
          breakdown: breakdown ?? null,
        },
        id,
      );
      const pool = this.budgetStatus(agent.tree_id);
      if (pool.enforced) {
        if (
          pool.excessLiabilityTokens > 0 &&
          previousPool.excessLiabilityTokens === 0
        )
          this.event(agent, "budget.tree_overcommitted", pool, id);
      } else if (pool.warningExceeded && !previousPool.warningExceeded) {
        this.event(agent, "usage.threshold_exceeded", pool, id);
      }
    });
    this.applyPendingReceipts();
  }
  accounting(id: string) {
    this.attempt(id);
    const row = this.one(
      "SELECT * FROM attempt_accounting WHERE attempt_id=?",
      id,
    )!;
    return {
      charged: Number(row.charged),
      finalized: row.finalized === 1,
      source: String(row.source),
    };
  }
  /** Retain verified operator evidence even when predecessor evidence is missing.
   * Pending receipts do not release reservations or erase observed facts. */
  submitUsageReceipt(
    id: string,
    generation: number,
    tokens: number,
    reason: string,
  ) {
    integer(tokens, "attested final usage");
    text(reason, "settlement reason", 2048);
    this.transaction(() => {
      const a = this.attempt(id);
      requireCondition(
        a.binding_generation === generation,
        "STALE_BINDING",
        "Settlement binding mismatch",
      );
      requireCondition(
        ["completed", "failed", "interrupted"].includes(a.state),
        "CONFLICT",
        "Settlement requires terminal execution",
      );
      this.run(
        "INSERT OR IGNORE INTO usage_receipts(attempt_id,tokens,reason) VALUES(?,?,?)",
        id,
        tokens,
        reason,
      );
      this.event(
        this.agent(a.agent_id),
        "usage.receipt.received",
        { tokens, reason },
        id,
      );
    });
    this.applyPendingReceipts();
    return this.usageReceipts(id);
  }
  usageReceipts(id: string) {
    return this.all(
      "SELECT tokens,reason,state FROM usage_receipts WHERE attempt_id=? ORDER BY sequence",
      id,
    );
  }
  private applyPendingReceipts() {
    if (this.drainingReceipts) return;
    this.drainingReceipts = true;
    try {
      let progress: boolean;
      do {
        progress = false;
        for (const r of this.all(
          "SELECT * FROM usage_receipts WHERE state='pending' ORDER BY sequence",
        )) {
          const a = this.attempt(String(r.attempt_id));
          try {
            this.settleFinalUsage(
              a.id,
              a.binding_generation,
              Number(r.tokens),
              String(r.reason),
            );
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "CONFLICT"
            )
              continue;
            throw error;
          }
          this.transaction(() => {
            this.run(
              "UPDATE usage_receipts SET state='applied' WHERE sequence=?",
              Number(r.sequence),
            );
          });
          progress = true;
        }
      } while (progress);
    } finally {
      this.drainingReceipts = false;
    }
  }
  settleFinalUsage(
    id: string,
    generation: number,
    tokens: number,
    reason: string,
  ) {
    integer(tokens, "attested final usage");
    text(reason, "settlement reason", 2048);
    this.transaction(() => {
      const a = this.attempt(id);
      requireCondition(
        a.binding_generation === generation,
        "STALE_BINDING",
        "Settlement binding mismatch",
      );
      requireCondition(
        ["completed", "failed", "interrupted"].includes(a.state),
        "CONFLICT",
        "Settlement requires terminal execution",
      );
      const accounting = this.one(
        "SELECT * FROM attempt_accounting WHERE attempt_id=?",
        id,
      )!;
      requireCondition(
        tokens >= Number(accounting.charged) && tokens >= (a.observed ?? 0),
        "CONFLICT",
        "Cannot erase observed or already charged usage",
      );
      this.run(
        "INSERT INTO usage_evidence(attempt_id,attested) VALUES(?,?) ON CONFLICT(attempt_id) DO UPDATE SET attested=excluded.attested",
        id,
        tokens,
      );
      this.run(
        "UPDATE attempt_accounting SET source='human-attested' WHERE attempt_id=?",
        id,
      );
      this.reconcileUsage(a.thread_id, generation);
      this.event(
        this.agent(a.agent_id),
        "budget.settled",
        {
          tokens,
          nativeObserved: a.observed,
          source: "human-attested",
          reason,
        },
        id,
      );
      this.releaseTerminated(a.agent_id);
    });
    this.applyPendingReceipts();
  }
  events(agentId: string): Row[] {
    this.agent(agentId);
    return this.all(
      "SELECT * FROM events WHERE agent_id=? ORDER BY sequence",
      agentId,
    );
  }
  eventCursor(treeId?: string): number {
    return Number(
      this.one(
        `SELECT MAX(sequence) AS n FROM events${treeId ? " WHERE tree_id=?" : ""}`,
        ...(treeId ? [treeId] : []),
      )?.n ?? 0,
    );
  }
  eventPage(treeId: string, after: number): Row[] {
    return this.all(
      "SELECT sequence,kind,agent_id,attempt_id,created_at FROM events WHERE tree_id=? AND sequence>? ORDER BY sequence LIMIT 100",
      treeId,
      after,
    );
  }
  waitForCommit(signal: AbortSignal): Promise<void> {
    requireCondition(!this.closed, "STALE_OWNER", "Store is closed");
    signal.throwIfAborted();
    return new Promise<void>((resolve) => {
      const finish = () => {
        this.commitWaiters.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      this.commitWaiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
  close() {
    if (this.closed) return;
    try {
      this.transaction(() => {
        this.run(
          "UPDATE owner SET id=NULL,pid=NULL,identity=NULL WHERE singleton=1 AND id=?",
          this.ownerId,
        );
      });
    } finally {
      this.closed = true;
      for (const resolve of [...this.commitWaiters]) resolve();
      this.db.close();
    }
  }
}
