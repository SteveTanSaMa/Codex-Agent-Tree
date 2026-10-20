import { reminderPolicy } from "./token-reminders.ts";
import type { DatabaseSync } from "node:sqlite";
import { integer, requireCondition, text } from "../core/errors.ts";
import type { Agent, Attempt } from "./store.ts";
export interface InteractionPolicy {
  mode: "interactive" | "batch";
  autonomyWarnMs: number | null;
  autonomyPauseMs: number | null;
  stallWarnMs: number | null;
  repeatErrorThreshold: number;
  taskTokenBudget: number | null;
  taskTimeBudgetMs: number | null;
}
export const interactionDefaults: InteractionPolicy = {
  mode: "interactive",
  autonomyWarnMs: 900000,
  autonomyPauseMs: null,
  stallWarnMs: 600000,
  repeatErrorThreshold: 8,
  taskTokenBudget: null,
  taskTimeBudgetMs: null,
};
export function interactionPolicy(value: unknown): InteractionPolicy {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_INPUT",
    "Expected interaction policy",
  );
  const p = value as Record<string, unknown>;
  requireCondition(
    Object.keys(p).every((k) => Object.hasOwn(interactionDefaults, k)),
    "INVALID_INPUT",
    "Unknown interaction policy field",
  );
  const result = { ...interactionDefaults, ...p } as InteractionPolicy;
  requireCondition(
    ["interactive", "batch"].includes(result.mode),
    "INVALID_INPUT",
    "Invalid interaction mode",
  );
  for (const k of [
    "autonomyWarnMs",
    "autonomyPauseMs",
    "stallWarnMs",
    "taskTokenBudget",
    "taskTimeBudgetMs",
  ] as const)
    if (result[k] !== null) integer(result[k]!, k, 1);
  integer(result.repeatErrorThreshold, "repeatErrorThreshold", 2);
  return result;
}
interface Context {
  db: DatabaseSync;
  transact<T>(fn: () => T): T;
  agent(id: string): Agent;
  attempt(id: string): Attempt;
  event(agent: Agent, kind: string, body: unknown): void;
}
export interface Guidance {
  message_id: string;
  agent_id: string;
  mode: string;
  state: string;
  attempt_id: string | null;
  turn_id: string | null;
  reason: string | null;
}
export class InteractionState {
  private c: Context;
  constructor(c: Context) {
    this.c = c;
  }
  policy(target: string): InteractionPolicy | null {
    const row = this.c.db
      .prepare("SELECT policy FROM tree_interaction WHERE tree_id=?")
      .get(this.c.agent(target).tree_id);
    return row ? JSON.parse(String(row.policy)) : null;
  }
  configure(target: string, value: unknown) {
    const policy = interactionPolicy(value);
    return this.c.transact(() => {
      const a = this.c.agent(target);
      this.c.db
        .prepare(
          "INSERT INTO tree_interaction(tree_id,policy) VALUES(?,?) ON CONFLICT(tree_id) DO UPDATE SET policy=excluded.policy",
        )
        .run(a.tree_id, JSON.stringify(policy));
      this.c.event(a, "interaction.policy", { policy });
      return policy;
    });
  }
  summary(target: string) {
    const tree = this.c.agent(target).tree_id;
    const clocks =
      this.c.db
        .prepare(
          "SELECT started_ms,epoch_ms,warned,paused FROM tree_interaction WHERE tree_id=?",
        )
        .get(tree) ?? null;
    const warnings = this.c.db
      .prepare(
        "SELECT created_at,body FROM events WHERE tree_id=? AND kind='interaction.warning' ORDER BY sequence DESC LIMIT 10",
      )
      .all(tree)
      .map((e) => ({ at: e.created_at, ...JSON.parse(String(e.body)) }));
    return {
      policy: this.policy(target),
      clocks,
      warnings,
      guidance: this.guidance(target).slice(-50),
    };
  }
  checkIn(target: string, time = Date.now()) {
    return this.c.transact(() => {
      const a = this.c.agent(target);
      this.c.db
        .prepare(
          "UPDATE tree_interaction SET epoch_ms=?,warned=0,paused=0,stall_marker=NULL,error_marker=NULL WHERE tree_id=?",
        )
        .run(time, a.tree_id);
      this.c.event(a, "interaction.check_in", { at: time });
    });
  }
  guidance(target: string) {
    return this.c.db
      .prepare(
        "SELECT g.*,m.status AS message_status FROM operator_guidance g JOIN operator_messages m ON m.id=g.message_id WHERE g.agent_id=? ORDER BY g.rowid",
      )
      .all(target) as unknown as Guidance[];
  }
  register(target: string, id: string, mode: string): Guidance {
    return this.c.transact(() => {
      const old = this.guidance(target).find((g) => g.message_id === id);
      requireCondition(
        !old || old.mode === mode,
        "CONFLICT",
        "Input key changed delivery mode",
      );
      if (!old) {
        this.c.db
          .prepare(
            "INSERT INTO operator_guidance(message_id,agent_id,mode,state) VALUES(?,?,?,'pending')",
          )
          .run(id, target, mode);
        this.c.event(this.c.agent(target), "guidance.accepted", {
          messageId: id,
          mode,
        });
      }
      return this.guidance(target).find((g) => g.message_id === id)!;
    });
  }
  claim(id: string, attempt: Attempt) {
    return this.c.transact(() => {
      const a = this.c.agent(attempt.agent_id);
      const current = this.c.attempt(attempt.id);
      requireCondition(
        !this.c.db
          .prepare("SELECT agent_id FROM runtime_blocks WHERE agent_id=?")
          .get(a.id) && !this.guidance(a.id).some((g) => g.state === "unknown"),
        "STATE_BLOCKED",
        "Unreconciled execution or guidance blocks steering",
      );
      requireCondition(
        a.desired === "active" &&
          current.agent_id === a.id &&
          current.state === "running" &&
          current.turn_id === attempt.turn_id,
        "STATE_BLOCKED",
        "Guidance requires the current running Turn",
      );
      requireCondition(
        this.c.db
          .prepare(
            "UPDATE operator_guidance SET state='dispatching',attempt_id=?,turn_id=? WHERE message_id=? AND state='pending'",
          )
          .run(attempt.id, attempt.turn_id, id).changes === 1,
        "CONFLICT",
        "Guidance was already claimed",
      );
      requireCondition(
        this.c.db
          .prepare(
            "UPDATE operator_messages SET status='delivering',attempt_id=? WHERE id=? AND status='queued'",
          )
          .run(attempt.id, id).changes === 1,
        "CONFLICT",
        "Message is no longer queued",
      );
      this.c.event(a, "guidance.dispatching", {
        messageId: id,
        attemptId: attempt.id,
        turnId: attempt.turn_id,
      });
    });
  }
  settle(
    id: string,
    state: "delivered" | "unknown" | "deferred",
    reason: string,
  ) {
    this.c.transact(() => {
      const g = this.c.db
        .prepare("SELECT * FROM operator_guidance WHERE message_id=?")
        .get(id) as unknown as Guidance;
      requireCondition(g, "NOT_FOUND", "Guidance not found");
      if (state === "deferred") {
        const current = this.c.db
          .prepare(
            "SELECT 1 FROM work_refs r JOIN work_epochs e ON e.agent_id=r.agent_id AND e.generation=r.generation WHERE r.kind='message' AND r.object_id=? AND r.agent_id=?",
          )
          .get(id, g.agent_id);
        requireCondition(
          current,
          "STATE_BLOCKED",
          "Withdrawn guidance cannot be retried into a new scope",
        );
      }
      this.c.db
        .prepare(
          "UPDATE operator_guidance SET state=?,reason=? WHERE message_id=?",
        )
        .run(state, reason, id);
      if (state === "deferred")
        this.c.db
          .prepare(
            "UPDATE operator_messages SET status='queued',attempt_id=NULL WHERE id=? AND status IN ('delivering','unknown','queued')",
          )
          .run(id);
      if (state === "unknown")
        this.c.db
          .prepare(
            "UPDATE operator_messages SET status='unknown' WHERE id=? AND status='delivering'",
          )
          .run(id);
      this.c.event(this.c.agent(g.agent_id), `guidance.${state}`, {
        messageId: id,
        reason,
      });
    });
  }
  mustInterrupt(target: string) {
    return !!this.c.db
      .prepare("SELECT agent_id FROM immediate_pauses WHERE agent_id=?")
      .get(target);
  }
  recover() {
    for (const row of this.c.db
      .prepare(
        "SELECT message_id FROM operator_guidance WHERE state='dispatching'",
      )
      .all())
      this.settle(
        String(row.message_id),
        "unknown",
        "Coordinator restarted during delivery; no automatic replay",
      );
  }
  resolve(
    target: string,
    id: string,
    outcome: "delivered" | "retry-next",
    reason: string,
  ) {
    text(reason, "review reason", 2048);
    requireCondition(
      outcome === "delivered" || outcome === "retry-next",
      "INVALID_INPUT",
      "Invalid guidance resolution",
    );
    requireCondition(
      this.guidance(target).some(
        (g) => g.message_id === id && g.state === "unknown",
      ),
      "CONFLICT",
      "Only unknown guidance can be resolved",
    );
    this.settle(
      id,
      outcome === "delivered" ? "delivered" : "deferred",
      `Operator review: ${reason}`,
    );
  }
  // Durable tree-wide clocks; routine agent messages never reset the autonomy epoch.
  evaluate(
    target: string,
    working: boolean,
    observedTokens: number,
    time = Date.now(),
  ) {
    return this.c.transact(() => {
      const a = this.c.agent(target),
        db = this.c.db;
      const row = db
        .prepare("SELECT * FROM tree_interaction WHERE tree_id=?")
        .get(a.tree_id);
      if (!row) return { warnings: [] as string[], pause: false };
      if (!working) {
        if (row.epoch_ms !== null)
          db.prepare(
            "UPDATE tree_interaction SET epoch_ms=NULL,warned=0 WHERE tree_id=?",
          ).run(a.tree_id);
        return { warnings: [] as string[], pause: false };
      }
      const p = JSON.parse(String(row.policy)) as InteractionPolicy;
      const start = row.started_ms === null ? time : Number(row.started_ms);
      const epoch = row.epoch_ms === null ? time : Number(row.epoch_ms);
      if (row.started_ms === null || row.epoch_ms === null) {
        this.c.event(a, "interaction.epoch_started", {
          startedMs: start,
          epochMs: epoch,
        });
        db.prepare(
          "UPDATE tree_interaction SET started_ms=COALESCE(started_ms,?),epoch_ms=COALESCE(epoch_ms,?) WHERE tree_id=?",
        ).run(start, epoch, a.tree_id);
      }
      const warnings: string[] = [];
      if (
        p.autonomyWarnMs !== null &&
        time - epoch >= p.autonomyWarnMs &&
        !row.warned
      ) {
        warnings.push("autonomy-duration");
        db.prepare("UPDATE tree_interaction SET warned=1 WHERE tree_id=?").run(
          a.tree_id,
        );
      }
      const pause =
        (p.autonomyPauseMs !== null && time - epoch >= p.autonomyPauseMs) ||
        (p.taskTimeBudgetMs !== null && time - start >= p.taskTimeBudgetMs) ||
        (p.taskTokenBudget !== null && observedTokens >= p.taskTokenBudget);
      if (pause)
        db.prepare("UPDATE tree_interaction SET paused=1 WHERE tree_id=?").run(
          a.tree_id,
        );
      for (const reason of warnings)
        this.c.event(a, "interaction.warning", { reason, epochMs: epoch });
      if (pause && !row.paused)
        this.c.event(a, "interaction.pause_requested", {
          observedTokens,
          epochMs: epoch,
          startedMs: start,
        });
      return { warnings, pause };
    });
  }
  stall(target: string, time = Date.now()) {
    return this.c.transact(() => {
      const a = this.c.agent(target),
        row = this.c.db
          .prepare("SELECT * FROM tree_interaction WHERE tree_id=?")
          .get(a.tree_id);
      if (!row) return;
      const p = JSON.parse(String(row.policy)) as InteractionPolicy;
      const progress = this.c.db
        .prepare(
          "SELECT MAX(created_at) AS at FROM events WHERE tree_id=? AND kind IN ('workspace.tool.completed','task.updated','task.created','turn.finished')",
        )
        .get(a.tree_id);
      // No claim of semantic progress: this detects absence of selected observable activity.
      const last = Math.max(
        progress?.at ? Date.parse(String(progress.at)) : 0,
        Number(row.epoch_ms ?? row.started_ms ?? time),
      );
      if (
        p.stallWarnMs !== null &&
        time - last >= p.stallWarnMs &&
        row.stall_marker !== last
      ) {
        this.c.db
          .prepare("UPDATE tree_interaction SET stall_marker=? WHERE tree_id=?")
          .run(last, a.tree_id);
        this.c.event(a, "interaction.warning", {
          reason: "no-observable-progress",
          sinceMs: last,
        });
      }
      const errors = this.c.db
        .prepare(
          "SELECT kind,body,sequence FROM events WHERE tree_id=? AND sequence > COALESCE((SELECT MAX(sequence) FROM events WHERE tree_id=? AND kind IN ('interaction.check_in','interaction.epoch_started')),0) AND kind IN ('tool.rejected','tool.completed') ORDER BY sequence DESC LIMIT ?",
        )
        .all(a.tree_id, a.tree_id, p.repeatErrorThreshold);
      const signature = (e: (typeof errors)[number]) => {
        const r = JSON.parse(String(e.body));
        return JSON.stringify([r.tool, r.code]);
      };
      const lastSuccess = this.c.db
        .prepare(
          "SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE tree_id=? AND kind='tool.completed'",
        )
        .get(a.tree_id)!.n;
      if (
        errors.length === p.repeatErrorThreshold &&
        errors.every(
          (e) =>
            e.kind === "tool.rejected" &&
            signature(e) === signature(errors[0]!),
        ) &&
        row.error_marker !== lastSuccess
      ) {
        this.c.db
          .prepare("UPDATE tree_interaction SET error_marker=? WHERE tree_id=?")
          .run(lastSuccess!, a.tree_id);
        this.c.event(a, "interaction.warning", {
          reason: "repeated-tool-rejection",
          count: errors.length,
        });
      }
    });
  }
}

/** Public root-command defaults; old persisted trees are never reinterpreted. */
export function rootSettings(p: Record<string, unknown>) {
  requireCondition(
    p.tokenPolicy === undefined ||
      p.tokenPolicy === "observe" ||
      p.tokenPolicy === "enforce",
    "INVALID_INPUT",
    "Invalid token policy",
  );
  requireCondition(
    p.tokenPolicy === undefined || p.tokenPolicy === "observe",
    "INVALID_INPUT",
    "New trees use reminders, not per-Agent token allocations; use an optional taskTokenBudget",
  );
  const limit = (v: unknown, name: string) =>
    v === null || v === "unlimited" ? null : integer(Number(v), name, 1);
  const policy = interactionPolicy({
    mode: p.mode ?? "interactive",
    ...(p.repeatErrorThreshold === undefined
      ? {}
      : { repeatErrorThreshold: Number(p.repeatErrorThreshold) }),
    ...Object.fromEntries(
      [
        "autonomyWarnMs",
        "autonomyPauseMs",
        "stallWarnMs",
        "taskTokenBudget",
        "taskTimeBudgetMs",
      ]
        .filter((k) => p[k] !== undefined)
        .map((k) => [k, limit(p[k], k)]),
    ),
  });
  const limits = {
    tokenPolicy: (p.tokenPolicy ?? "observe") as "observe" | "enforce",
    maxTotalTurns: limit(
      p.maxTotalTurns === undefined
        ? policy.mode === "interactive"
          ? null
          : 100
        : p.maxTotalTurns,
      "maxTotalTurns",
    ),
    maxTurnsPerAgent: limit(
      p.maxTurns === undefined
        ? policy.mode === "interactive"
          ? null
          : 20
        : p.maxTurns,
      "maxTurnsPerAgent",
    ),
    tokens: Number(p.tokenAlertAt ?? p.tokens ?? 5000000),
    maxDepth: Number(p.maxDepth ?? 2),
    maxAgents: Number(p.maxAgents ?? 20),
    maxConcurrentTurns: Number(p.concurrent ?? 3),
    turnReservation: Number(p.reserve ?? 5000),
  };
  const reminder = reminderPolicy({
    metric: p.tokenAlertMetric ?? "total",
    thresholdTokens: limits.tokens,
    repeatEveryTokens:
      p.tokenAlertEvery === undefined ? null : Number(p.tokenAlertEvery),
  });
  return { policy, limits, reminder };
}
