import type { DatabaseSync } from "node:sqlite";
import type { Agent } from "./store.ts";
import { integer, requireCondition } from "../core/errors.ts";
export interface ReminderPolicy {
  metric: "total" | "uncachedInput" | "output";
  thresholdTokens: number;
  repeatEveryTokens: number | null;
}
export function reminderPolicy(value: unknown): ReminderPolicy | null {
  let policy: ReminderPolicy | null = null;
  if (value !== null) {
    requireCondition(
      value !== null && typeof value === "object" && !Array.isArray(value),
      "INVALID_INPUT",
      "Expected reminder policy or null",
    );
    const p = value as Record<string, unknown>;
    requireCondition(
      Object.keys(p).every((k) =>
        ["metric", "thresholdTokens", "repeatEveryTokens"].includes(k),
      ),
      "INVALID_INPUT",
      "Unknown reminder field",
    );
    requireCondition(
      ["total", "uncachedInput", "output"].includes(String(p.metric)),
      "INVALID_INPUT",
      "Invalid reminder metric",
    );
    policy = {
      metric: p.metric as ReminderPolicy["metric"],
      thresholdTokens: integer(
        p.thresholdTokens as number,
        "thresholdTokens",
        1,
      ),
      repeatEveryTokens:
        p.repeatEveryTokens === undefined || p.repeatEveryTokens === null
          ? null
          : integer(p.repeatEveryTokens as number, "repeatEveryTokens", 1),
    };
  }
  return policy;
}
type Scope = "agent" | "tree";
interface Context {
  db: DatabaseSync;
  agent(id: string): Agent;
  transact<T>(fn: () => T): T;
  event(agent: Agent, kind: string, body: unknown): void;
}
const fields = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;
export class TokenReminders {
  private c: Context;
  constructor(c: Context) {
    this.c = c;
  }
  private identity(target: string, scope: Scope) {
    requireCondition(
      scope === "agent" || scope === "tree",
      "INVALID_INPUT",
      "Invalid reminder scope",
    );
    const a = this.c.agent(target);
    return { a, id: scope === "tree" ? a.tree_id : a.id };
  }
  // Called inside the usage transaction; duplicate/late samples cannot inflate cumulative totals.
  sample(agent: string, thread: string, cumulative: number, raw: unknown) {
    const db = this.c.db;
    const old = db
      .prepare(
        "SELECT cumulative,breakdown FROM token_usage_samples WHERE thread_id=?",
      )
      .get(thread);
    if (old && Number(old.cumulative) > cumulative) return;
    if (old && Number(old.cumulative) === cumulative && !raw) return;
    const r =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const snapshot = Object.fromEntries(
      fields.map((k) => [
        k,
        Number.isSafeInteger(r[k]) && Number(r[k]) >= 0 ? Number(r[k]) : null,
      ]),
    );
    if (
      snapshot.inputTokens !== null &&
      snapshot.outputTokens !== null &&
      snapshot.inputTokens! + snapshot.outputTokens! !== cumulative
    )
      for (const k of fields) snapshot[k] = null;
    if (
      snapshot.cachedInputTokens !== null &&
      (snapshot.inputTokens === null ||
        snapshot.cachedInputTokens! > snapshot.inputTokens!)
    )
      snapshot.cachedInputTokens = null;
    if (
      snapshot.reasoningOutputTokens !== null &&
      (snapshot.outputTokens === null ||
        snapshot.reasoningOutputTokens! > snapshot.outputTokens!)
    )
      snapshot.reasoningOutputTokens = null;
    db.prepare(
      "INSERT INTO token_usage_samples VALUES(?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET cumulative=excluded.cumulative,breakdown=excluded.breakdown",
    ).run(thread, agent, cumulative, JSON.stringify(snapshot));
  }
  initialize(backfill: boolean) {
    this.c.transact(() => {
      const db = this.c.db;
      for (const tree of db.prepare("SELECT * FROM trees").all()) {
        const limits = JSON.parse(String(tree.limits_json));
        const threshold = limits.tokens;
        if (limits.tokenPolicy === "observe")
          db.prepare("UPDATE agents SET capacity=0 WHERE tree_id=?").run(
            tree.id!,
          );
        const reminded = !!db
          .prepare(
            "SELECT id FROM events WHERE tree_id=? AND kind='usage.threshold_exceeded' LIMIT 1",
          )
          .get(tree.id!);
        db.prepare(
          "INSERT OR IGNORE INTO token_reminders(scope,target_id,policy,last_threshold) VALUES('tree',?,?,?)",
        ).run(
          tree.id!,
          JSON.stringify({
            metric: "total",
            thresholdTokens: threshold,
            repeatEveryTokens: null,
          }),
          reminded ? threshold : null,
        );
      }
      if (backfill)
        for (const row of db
          .prepare(
            "SELECT t.agent_id,t.thread_id,e.body FROM events e JOIN turn_attempts t ON t.id=e.attempt_id WHERE e.kind='usage.observed' ORDER BY e.sequence",
          )
          .all()) {
          const b = JSON.parse(String(row.body));
          if (
            Number.isSafeInteger(b.cumulativeTokens) &&
            b.cumulativeTokens >= 0
          )
            this.sample(
              String(row.agent_id),
              String(row.thread_id),
              b.cumulativeTokens,
              b.breakdown?.total,
            );
        }
    });
  }
  metrics(target: string, scope: Scope) {
    const { id } = this.identity(target, scope),
      db = this.c.db;
    const clause = scope === "agent" ? "a.id=?" : "a.tree_id=?";
    const attributed = Number(
      db
        .prepare(
          `SELECT COALESCE(SUM(MAX(COALESCE(t.observed,0),COALESCE(c.charged,0))),0) AS n FROM turn_attempts t JOIN agents a ON a.id=t.agent_id LEFT JOIN attempt_accounting c ON c.attempt_id=t.id WHERE ${clause}`,
        )
        .get(id)!.n,
    );
    const samples = db
      .prepare(
        `SELECT s.cumulative,s.breakdown FROM token_usage_samples s JOIN agents a ON a.id=s.agent_id WHERE ${clause}`,
      )
      .all(id);
    const native = samples.reduce((n, r) => n + Number(r.cumulative), 0);
    const totalTokens = Math.max(attributed, native);
    const snapshots = samples.map(
      (r) => JSON.parse(String(r.breakdown)) as Record<string, number | null>,
    );
    const detailed = Object.fromEntries(
      fields.map((k) => [
        k,
        snapshots.length &&
        native >= attributed &&
        snapshots.every((s) => s[k] !== null)
          ? snapshots.reduce((n, s) => n + s[k]!, 0)
          : null,
      ]),
    ) as Record<(typeof fields)[number], number | null>;
    return {
      totalTokens,
      ...detailed,
      uncachedInputTokens:
        detailed.inputTokens !== null && detailed.cachedInputTokens !== null
          ? detailed.inputTokens! - detailed.cachedInputTokens!
          : null,
    };
  }
  configure(target: string, scope: Scope, value: unknown) {
    const { a, id } = this.identity(target, scope);
    const policy = reminderPolicy(value);
    return this.c.transact(() => {
      const encoded = JSON.stringify(policy);
      const old = this.c.db
        .prepare(
          "SELECT policy FROM token_reminders WHERE scope=? AND target_id=?",
        )
        .get(scope, id);
      if (!old || old.policy !== encoded) {
        this.c.db
          .prepare(
            "INSERT INTO token_reminders VALUES(?,?,?,NULL) ON CONFLICT(scope,target_id) DO UPDATE SET policy=excluded.policy,last_threshold=NULL",
          )
          .run(scope, id, encoded);
        this.c.event(a, "usage.reminder_configured", {
          scope,
          targetId: id,
          policy,
        });
        this.check(target);
      }
      return this.summary(target, scope);
    });
  }
  summary(target: string, scope: Scope) {
    const { id } = this.identity(target, scope);
    const row = this.c.db
      .prepare(
        "SELECT policy,last_threshold FROM token_reminders WHERE scope=? AND target_id=?",
      )
      .get(scope, id);
    const policy: ReminderPolicy | null = row
      ? JSON.parse(String(row.policy))
      : null;
    const metrics = this.metrics(target, scope);
    const observed = policy
      ? policy.metric === "total"
        ? metrics.totalTokens
        : policy.metric === "uncachedInput"
          ? metrics.uncachedInputTokens
          : metrics.outputTokens
      : null;
    const lastThreshold =
      row?.last_threshold === null || !row ? null : Number(row.last_threshold);
    const nextThreshold = !policy
      ? null
      : lastThreshold === null
        ? policy.thresholdTokens
        : policy.repeatEveryTokens === null
          ? null
          : lastThreshold + policy.repeatEveryTokens;
    return {
      scope,
      targetId: id,
      policy,
      metrics,
      observedTokens: observed,
      lastThreshold,
      nextThreshold,
      metricAvailable: observed !== null,
      stopsExecution: false,
    };
  }
  // Must be called by an owning Store transaction; reminder cursor and event commit together.
  check(target: string) {
    for (const scope of ["agent", "tree"] as const) {
      const s = this.summary(target, scope),
        p = s.policy;
      if (
        !p ||
        s.observedTokens === null ||
        s.nextThreshold === null ||
        s.observedTokens < s.nextThreshold
      )
        continue;
      const last =
        p.repeatEveryTokens === null
          ? p.thresholdTokens
          : p.thresholdTokens +
            Math.floor(
              (s.observedTokens - p.thresholdTokens) / p.repeatEveryTokens,
            ) *
              p.repeatEveryTokens;
      const count =
        p.repeatEveryTokens === null
          ? 1
          : Math.floor((last - s.nextThreshold) / p.repeatEveryTokens) + 1;
      this.c.db
        .prepare(
          "UPDATE token_reminders SET last_threshold=? WHERE scope=? AND target_id=?",
        )
        .run(last, scope, s.targetId);
      const agent =
        scope === "agent"
          ? this.c.agent(target)
          : this.c.agent(
              String(
                this.c.db
                  .prepare(
                    "SELECT id FROM agents WHERE tree_id=? AND parent_id IS NULL",
                  )
                  .get(s.targetId)!.id,
              ),
            );
      this.c.event(agent, "usage.reminder", {
        scope,
        targetId: s.targetId,
        metric: p.metric,
        observedTokens: s.observedTokens,
        firstThreshold: s.nextThreshold,
        lastThreshold: last,
        crossedCount: count,
        stopsExecution: false,
      });
    }
  }
}
