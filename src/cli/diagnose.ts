import { worktreeDiagnosis } from "./worktree-diagnosis.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
/** Opens no Store lease, migrates nothing and executes no recovery operation. */
export function diagnose(state: string) {
  const path = join(state, "business.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => String(r.name)),
    );
    const availability = (table: string, columns: string[]) => {
      if (!tables.has(table)) return "table-missing";
      // Table names are fixed literals at call sites, never user input.
      const present = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((r) => String(r.name)),
      );
      return columns.every((column) => present.has(column))
        ? "available"
        : "columns-missing";
    };
    const diagnosticAvailability = {
      unknownAttempts: availability("turn_attempts", [
        "id",
        "agent_id",
        "thread_id",
        "turn_id",
        "state",
        "result",
      ]),
      unknownCommands: availability("workspace_commands", [
        "agent_id",
        "call_id",
        "state",
        "created_at",
        "result_json",
      ]),
      runtimeBlocks: availability("runtime_blocks", ["agent_id", "created_at"]),
      unknownGuidance: availability("operator_guidance", [
        "message_id",
        "agent_id",
        "attempt_id",
        "turn_id",
        "state",
      ]),
      recentFailedAttempts: availability("turn_attempts", [
        "id",
        "agent_id",
        "thread_id",
        "turn_id",
        "state",
        "completed_at",
      ]),
      agentsWithErrors: availability("agents", ["id", "last_error"]),
    };
    const attempts =
      diagnosticAvailability.unknownAttempts === "available"
        ? db
            .prepare(
              "SELECT id,agent_id,thread_id,turn_id,state,result FROM turn_attempts WHERE state='unknown'",
            )
            .all()
        : [];
    const commands =
      diagnosticAvailability.unknownCommands === "available"
        ? db
            .prepare(
              "SELECT agent_id,call_id,state,created_at,result_json FROM workspace_commands WHERE state!='completed'",
            )
            .all()
        : [];
    const workspace = worktreeDiagnosis(db, state);
    const blocks =
      diagnosticAvailability.runtimeBlocks === "available"
        ? db
            .prepare(
              "SELECT agent_id,created_at FROM runtime_blocks ORDER BY created_at DESC LIMIT 100",
            )
            .all()
        : [];
    const guidance =
      diagnosticAvailability.unknownGuidance === "available"
        ? db
            .prepare(
              "SELECT message_id,agent_id,attempt_id,turn_id,state FROM operator_guidance WHERE state='unknown' ORDER BY rowid DESC LIMIT 100",
            )
            .all()
        : [];
    const failed =
      diagnosticAvailability.recentFailedAttempts === "available"
        ? db
            .prepare(
              "SELECT id,agent_id,thread_id,turn_id,state,completed_at FROM turn_attempts WHERE state IN ('failed','interrupted') ORDER BY rowid DESC LIMIT 100",
            )
            .all()
        : [];
    const errored =
      diagnosticAvailability.agentsWithErrors === "available"
        ? db
            .prepare(
              "SELECT id,last_error IS NOT NULL AS has_error FROM agents WHERE last_error IS NOT NULL LIMIT 100",
            )
            .all()
        : [];
    return {
      readOnly: true,
      database: path,
      diagnosticAvailability,
      integrity: db.prepare("PRAGMA quick_check").get(),
      evidence: {
        events:
          "events table: filter agent_id/attempt_id; preserve body and sequence",
        config: join(state, "config.json"),
        worktreeMarkers: join(state, "worktree-ready"),
      },
      unknownAttempts: attempts.map((a) => ({
        ...a,
        reason:
          "Dispatch/terminal outcome not uniquely established; this is not permission to retry",
        commands: [
          ["native-history", "--target", a.agent_id, "--state", state],
          ["status", "--target", a.agent_id, "--state", state],
        ],
        recovery:
          "Compare exact Turn ID and attempt marker. Reconnect/start to run conservative reconciliation. If evidence remains ambiguous, keep unknown; do not send the work again. Usage settlement is not execution settlement.",
      })),
      unknownCommands: commands.map((c) => ({
        ...c,
        reason: "A command receipt does not prove successful completion",
        preview: [
          "command-review",
          "--target",
          c.agent_id,
          "--call-id",
          c.call_id,
          "--reason",
          "<document observed filesystem/process evidence>",
          "--state",
          state,
        ],
        recovery:
          "Review file diffs, test output and surviving processes before explicit command-review. Review records uncertainty; it never claims success or reruns the command.",
      })),
      runtimeBlocks: blocks.map((b) => ({
        ...b,
        reason:
          "Native activity or execution ownership requires reconciliation; inspect the stored block and native history",
        evidence: ["runtime_blocks", "runtime_block_turns", "events"],
        commands: [
          ["status", "--target", b.agent_id, "--state", state],
          ["native-history", "--target", b.agent_id, "--state", state],
        ],
        recovery:
          "Preserve the block. Release only after reviewing native history and confirming no active Turn; never replay an unknown attempt to clear it.",
      })),
      unknownGuidance: guidance.map((g) => ({
        ...g,
        reason: "Live guidance delivery cannot be established from its receipt",
        evidence: ["operator_guidance", "operator_messages", "events"],
        recovery:
          "Inspect native history and the existing message before any explicit guidance-resolve; do not automatically resend.",
      })),
      recentFailedAttempts: failed.map((a) => ({
        ...a,
        reason:
          "A terminal failure or interruption is not proof of the absence of external side effects",
        evidence: ["turn_attempts", "events", "native-history"],
      })),
      agentsWithErrors: errored.map((a) => ({
        agent_id: a.id,
        evidence:
          "agents.last_error and events (may contain sensitive details)",
        recovery:
          "Inspect the existing state and correlated attempt before deciding whether any new work is safe.",
      })),
      diagnosticLimits: {
        runtimeBlocks: 100,
        unknownGuidance: 100,
        recentFailedAttempts: 100,
        agentsWithErrors: 100,
        note: "These lists are bounded; consult status and paged audit history for additional records. Existing unknown attempt and command lists retain their prior behavior.",
      },
      ...workspace,
    };
  } finally {
    db.close();
  }
}
