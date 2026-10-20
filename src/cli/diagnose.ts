import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
/** Opens no Store lease, migrates nothing and executes no recovery operation. */
export function diagnose(state: string) {
  const path = join(state, "business.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const attempts = db
      .prepare(
        "SELECT id,agent_id,thread_id,turn_id,state,result FROM turn_attempts WHERE state='unknown'",
      )
      .all();
    const commands = db
      .prepare(
        "SELECT agent_id,call_id,state,created_at,result_json FROM workspace_commands WHERE state!='completed'",
      )
      .all();
    const markers = new Map<string, string>();
    const worktrees: object[] = [];
    const malformedMarkers: string[] = [];
    function scanMarkers(dir: string) {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) scanMarkers(p);
        else if (e.isFile())
          try {
            const v = JSON.parse(readFileSync(p, "utf8"));
            if (typeof v.path === "string") markers.set(v.path, p);
          } catch {
            malformedMarkers.push(p);
          }
      }
    }
    scanMarkers(join(state, "worktree-ready"));
    function scan(dir: string, depth = 0) {
      if (!existsSync(dir) || depth > 2) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = join(dir, e.name);
        if (existsSync(join(p, ".git")))
          worktrees.push({
            path: p,
            marker: markers.get(p) ?? null,
            reason: markers.has(p)
              ? "Marker present; Git identity still requires verification"
              : "Incomplete provisioning: no completion marker",
            recovery:
              "Preserve diff and untracked files; compare git worktree list --porcelain against config.json and marker identity. Provision a fresh authorized child and transfer reviewed changes; do not reset or auto-adopt this checkout.",
          });
        else scan(p, depth + 1);
      }
    }
    scan(join(state, "workspaces"));
    return {
      readOnly: true,
      database: path,
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
      malformedMarkers,
      worktrees,
    };
  } finally {
    db.close();
  }
}
